'use strict';

// Env is read at require time, so configure it before loading the app
process.env.MACHINE_ID = 'machine-1';
process.env.SIMULATE_GPU = 'true';
delete process.env.CONTAINER_MEM_LIMIT_MB;

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(console, 'log', () => {}); // silence structured fault logs

const { createApp } = require('../src/index');
const m = require('../src/metrics');
const { resetAll } = require('../src/faultRoutes');

const NODE_METRICS = [
  'node_ram_usage_percent',
  'node_cpu_load_percent',
  'node_gpu_utilization_percent',
  'node_container_restart_count',
  'node_active_connections',
];

let server;
let base;
let sharedOnlyServer;
let sharedOnlyBase;

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function close(s) {
  s.closeAllConnections();
  return new Promise((resolve) => s.close(resolve));
}

function metricValue(text, name) {
  const match = text.match(new RegExp(`^${name}\\{machine_id="machine-1"\\} (\\S+)$`, 'm'));
  assert.ok(match, `${name}{machine_id="machine-1"} missing from /metrics`);
  return Number(match[1]);
}

async function readMetric(name) {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  return metricValue(await res.text(), name);
}

const post = (path) => fetch(`${base}${path}`, { method: 'POST' });
const timeoutCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  server = await listen(createApp({ exclusiveService: true }));
  base = `http://127.0.0.1:${server.address().port}`;
  sharedOnlyServer = await listen(createApp({ exclusiveService: false }));
  sharedOnlyBase = `http://127.0.0.1:${sharedOnlyServer.address().port}`;
});

afterEach(() => {
  resetAll();
  m.state.draining = false;
});

after(async () => {
  resetAll();
  await close(server);
  await close(sharedOnlyServer);
});

test('GET /health returns 200 healthy with machineId and uptime', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'healthy');
  assert.equal(body.machineId, 'machine-1');
  assert.equal(typeof body.uptime, 'number');
});

test('GET /health returns 503 while draining', async () => {
  m.state.draining = true;
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'draining');
  assert.equal(body.machineId, 'machine-1');
});

test('GET /api/shared returns the shared-api payload', async () => {
  const res = await fetch(`${base}/api/shared`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.machineId, 'machine-1');
  assert.equal(body.service, 'shared-api');
  assert.equal(body.status, 'ok');
  assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
});

test('GET /api/gpu-render renders a frame on the exclusive node', async () => {
  const res = await fetch(`${base}/api/gpu-render`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.machineId, 'machine-1');
  assert.equal(body.service, 'gpu-renderer');
  assert.equal(body.status, 'Rendered Frame');
  assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
});

test('GET /api/gpu-render returns 404 JSON on a non-exclusive node', async () => {
  const res = await fetch(`${sharedOnlyBase}/api/gpu-render`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /exclusively/);
  assert.equal(body.machineId, 'machine-1');
});

test('GET /metrics exposes all five node_* metrics labelled machine_id plus default metrics', async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const text = await res.text();
  for (const name of NODE_METRICS) {
    assert.match(text, new RegExp(`^${name}\\{machine_id="machine-1"\\} [0-9.]+$`, 'm'), name);
  }
  assert.equal(metricValue(text, 'node_container_restart_count'), 0);
  assert.match(text, /^process_resident_memory_bytes\{machine_id="machine-1"\} \d+/m);
  assert.match(text, /^nodejs_heap_size_used_bytes\{machine_id="machine-1"\} \d+/m);
  assert.match(text, /^process_cpu_seconds_total\{machine_id="machine-1"\} [0-9.]+/m);
});

test('SIMULATE_GPU baseline stays within 8-15%', async () => {
  const gpu = await readMetric('node_gpu_utilization_percent');
  assert.ok(gpu >= 8 && gpu <= 15, `gpu baseline ${gpu}`);
});

test('POST /fault/gpu pins GPU at ~93% and is idempotent', async () => {
  let res = await post('/fault/gpu');
  assert.equal(res.status, 202);
  let body = await res.json();
  assert.equal(body.fault, 'gpu');
  assert.equal(body.started, true);
  assert.equal(body.faults.gpu, true);

  const gpu = await readMetric('node_gpu_utilization_percent');
  assert.ok(gpu >= 92 && gpu <= 94, `gpu ${gpu}`);

  res = await post('/fault/gpu');
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.started, false);
});

test('POST /fault/cpu reports >85% CPU while /metrics and /health stay responsive', async () => {
  const before = timeoutCount();
  const res = await post('/fault/cpu');
  assert.equal(res.status, 202);
  assert.equal((await post('/fault/cpu')).status, 200); // second call does not stack a loop
  assert.equal(timeoutCount(), before + 1);

  await sleep(300); // let the busy loop run a few cycles
  const t0 = Date.now();
  const cpu = await readMetric('node_cpu_load_percent');
  assert.ok(cpu > 85 && cpu <= 93, `cpu ${cpu}`);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.ok(Date.now() - t0 < 1000, 'event loop must not be frozen by the CPU fault');
});

test('POST /fault/container-loop increments the restart counter every 5s and holds RAM at ~88.5%', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const startCount = await readMetric('node_container_restart_count');

  const res = await post('/fault/container-loop');
  assert.equal(res.status, 202);
  assert.equal(await readMetric('node_container_restart_count'), startCount + 1); // immediate spin-up

  t.mock.timers.tick(5000);
  assert.equal(await readMetric('node_container_restart_count'), startCount + 2);
  t.mock.timers.tick(10000);
  assert.equal(await readMetric('node_container_restart_count'), startCount + 4);

  const ram = await readMetric('node_ram_usage_percent');
  assert.ok(ram >= 88 && ram <= 89, `ram ${ram}`);

  // repeated call must not stack a second interval
  assert.equal((await post('/fault/container-loop')).status, 200);
  t.mock.timers.tick(5000);
  assert.equal(await readMetric('node_container_restart_count'), startCount + 5);

  // after reset the loop stops
  assert.equal((await post('/fault/reset')).status, 200);
  t.mock.timers.tick(20000);
  assert.equal(await readMetric('node_container_restart_count'), startCount + 5);
});

test('POST /fault/reset restores baseline and clears all fault timers', async () => {
  const idleTimers = timeoutCount();
  for (const f of ['gpu', 'cpu', 'container-loop']) {
    assert.equal((await post(`/fault/${f}`)).status, 202);
  }
  assert.equal(timeoutCount(), idleTimers + 2); // cpu loop + container loop

  const res = await post('/fault/reset');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.fault, 'reset');
  assert.deepEqual(body.faults, { memory: false, cpu: false, gpu: false, containerLoop: false });
  assert.equal(timeoutCount(), idleTimers);

  const text = await (await fetch(`${base}/metrics`)).text();
  const gpu = metricValue(text, 'node_gpu_utilization_percent');
  assert.ok(gpu >= 8 && gpu <= 15, `gpu ${gpu}`);
  assert.ok(metricValue(text, 'node_cpu_load_percent') < 85);
  assert.ok(metricValue(text, 'node_ram_usage_percent') < 85);
});

test('unknown route returns 404 JSON', async () => {
  const res = await fetch(`${base}/does-not-exist`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not Found', path: '/does-not-exist', machineId: 'machine-1' });
});

test('malformed JSON body returns 400 JSON without a stack trace', async () => {
  const res = await fetch(`${base}/fault/gpu`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"bad json',
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const text = await res.text();
  assert.doesNotMatch(text, /\bat .*\.js/);
  assert.deepEqual(JSON.parse(text), { error: 'Bad Request', machineId: 'machine-1' });
  assert.equal(m.faults.gpu, false);
});
