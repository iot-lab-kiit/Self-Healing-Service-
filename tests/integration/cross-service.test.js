'use strict';

// Cross-service integration: the REAL machine-node, smart-lb-controller and remediation-engine code talking
// over HTTP on localhost. Only Docker is faked: container.restart() = POST /fault/reset on the node.
// Needs `npm install` in machine-node/, smart-lb-controller/ and remediation-engine/ first.
//   node --test tests/integration/cross-service.test.js
process.env.MACHINE_ID = 'machine-1';
process.env.EXCLUSIVE_SERVICE = 'true';
process.env.SIMULATE_GPU = 'true';
process.env.CONTAINER_MEM_LIMIT_MB = '256';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const req = (p) => require(path.join(ROOT, p));
const axios = req('remediation-engine/node_modules/axios');
const nodeApp = req('machine-node/src/index.js');
const nodeMetrics = req('machine-node/src/metrics.js');
const lbApp = req('smart-lb-controller/src/app.js');
const { createRemediator } = req('remediation-engine/src/dockerController.js');
const { createApp: createEngineApp } = req('remediation-engine/src/app.js');

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const json = (u, accept = 'application/json') => fetch(u, { headers: { Accept: accept } });

let NODE, LB, ENG, servers, engine, remediator, http, docker;
let restarting = false;

before(async () => {
  const nodeSrv = await listen(nodeApp.createApp());
  nodeMetrics.startSamplers();
  NODE = url(nodeSrv);
  const lbSrv = await listen(lbApp.createApp({ gpuUpstream: NODE, logger: quiet }));
  LB = url(lbSrv);

  // machine-1:3000 is resolved by Docker DNS in the cluster; here it maps to the local node server
  const real = axios.create({ proxy: false });
  http = {
    post: (u, b, o) => real.post(u, b, o),
    get: (u, o) => real.get(u.replace(/^http:\/\/machine-1:3000/, NODE), o),
  };
  docker = {
    listContainers: async () => [{ Id: 'id-machine-1', Names: ['/machine-1'], Labels: { 'com.docker.compose.service': 'machine-1' } }],
    getContainer: () => ({
      restart: async () => {
        restarting = true;
        await sleep(400); // window in which the LB must be gating traffic
        await real.post(`${NODE}/fault/reset`);
        restarting = false;
      },
    }),
  };
  remediator = createRemediator({ http, docker, lbUrl: LB, pollMs: 100, lbRetryDelayMs: 50, logger: quiet });
  engine = createEngineApp({ remediate: remediator.remediate, register: remediator.register, metrics: remediator.metrics, log: quiet });
  const engSrv = await listen(engine.app);
  ENG = url(engSrv);
  servers = [nodeSrv, lbSrv, engSrv];
});

after(async () => {
  await fetch(`${NODE}/fault/reset`, { method: 'POST' }).catch(() => {});
  for (const s of servers) s.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100).unref(); // node samplers are unref'd; this is a safety net
});

test('fault -> alert webhook -> LB gate -> restart -> ONLINE', async () => {
  let r = await json(`${LB}/api/gpu-render`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'Rendered Frame');

  await fetch(`${NODE}/fault/gpu`, { method: 'POST' });
  assert.ok((await remediator.readGauges('machine-1')).gpu > 85);

  const payload = fs.readFileSync(path.join(ROOT, 'remediation-engine/test/fixtures/firing-ram-gpu-machine1.json'), 'utf8');
  r = await fetch(`${ENG}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(r.status, 202);
  assert.deepEqual((await r.json()).accepted, ['machine-1']);

  // While the container restarts, the LB gates the exclusive service
  while (!restarting) await sleep(10);
  r = await json(`${LB}/api/gpu-render`);
  const gated = await r.json();
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '30');
  assert.equal(gated.error, 'Service Temporarily Rebooting');
  assert.equal(gated.machineId, 'machine-1');
  assert.equal(gated.retryAfterSeconds, 30);
  assert.equal(gated.reason, 'Sustained Resource Exhaustion (>85% for >=60s)');

  r = await json(`${LB}/api/gpu-render`, 'text/html,application/xhtml+xml');
  const html = await r.text();
  assert.equal(r.status, 503);
  assert.match(html, /machine-1/);
  assert.match(html, /&gt;85%/);

  let cs = await (await fetch(`${LB}/cluster-status`)).json();
  assert.equal(cs.machines['machine-1'].status, 'REBOOTING');
  assert.deepEqual(cs.machines['machine-1'].exclusiveServices, ['gpu-render']);

  await engine.idle();
  const st = await (await fetch(`${ENG}/status`)).json();
  assert.equal(st.history[0].result, 'success');
  assert.equal(st.history[0].vitalsRecovered, true);
  assert.equal(st.history[0].lbSynced, true);

  r = await json(`${LB}/api/gpu-render`);
  assert.equal(r.status, 200);
  cs = await (await fetch(`${LB}/cluster-status`)).json();
  assert.equal(cs.machines['machine-1'].status, 'ONLINE');

  const em = await (await fetch(`${ENG}/metrics`)).text();
  assert.match(em, /remediation_total\{machine_id="machine-1",result="success"\} 1/);
  assert.match(em, /remediation_duration_seconds_count\{machine_id="machine-1"\} 1/);
});

test('node exposes every invariant metric with machine_id', async () => {
  const nm = await (await fetch(`${NODE}/metrics`)).text();
  for (const k of ['node_ram_usage_percent', 'node_cpu_load_percent', 'node_gpu_utilization_percent', 'node_container_restart_count', 'node_active_connections']) {
    assert.match(nm, new RegExp(`^${k}\\{[^}]*machine_id="machine-1"[^}]*\\} `, 'm'), k);
  }
});

test('failed restart keeps the LB on REBOOTING with a fresh ETA, never ONLINE', async () => {
  const failing = createRemediator({
    http: { post: http.post, get: async () => ({ status: 503 }) },
    docker,
    lbUrl: LB,
    pollMs: 50,
    healthTimeoutMs: 300,
    lbRetryDelayMs: 50,
    logger: quiet,
  });
  await assert.rejects(failing.remediate('machine-1'), (err) => err.result === 'health_timeout');
  const m1 = (await (await fetch(`${LB}/cluster-status`)).json()).machines['machine-1'];
  assert.equal(m1.status, 'REBOOTING');
  assert.equal(m1.etaSeconds, 60);
  assert.match(m1.reason, /^Remediation failed: .* - retrying$/);
});
