'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, metricsText, connRefused } = require('./fakes');
const { REASON } = require('../src/dockerController');

const types = (calls) => calls.map((c) => (c.type === 'lb' ? `lb.${c.body.status}` : c.type));

// Invariant #5: the REBOOTING handshake must be attempted before container.restart()
function assertHandshakeBeforeRestart(calls) {
  const firstLb = calls.findIndex((c) => c.type === 'lb' && c.body.status === 'REBOOTING');
  const restart = calls.findIndex((c) => c.type === 'docker.restart');
  assert.ok(firstLb !== -1, 'REBOOTING handshake was never sent');
  if (restart !== -1) assert.ok(firstLb < restart, 'container.restart() ran before the REBOOTING handshake');
}

test('happy path: REBOOTING -> restart -> health -> metrics -> ONLINE', async () => {
  const h = createHarness();
  const out = await h.remediator.remediate('machine-1');

  assert.deepEqual(types(h.calls), ['lb.REBOOTING', 'docker.list', 'docker.restart', 'get.health', 'get.metrics', 'lb.ONLINE']);
  assertHandshakeBeforeRestart(h.calls);
  assert.deepEqual(h.calls[0].body, {
    machineId: 'machine-1',
    status: 'REBOOTING',
    reason: REASON,
    exclusiveServices: ['gpu-render'],
    etaSeconds: 30,
  });
  assert.equal(h.calls[0].url, 'http://smart-lb-controller:5000/internal/node-status');
  assert.deepEqual(h.calls[2], { type: 'docker.restart', id: 'id-machine-1', opts: { t: 5 } });
  assert.deepEqual(h.calls.at(-1).body, { machineId: 'machine-1', status: 'ONLINE' });

  assert.equal(out.result, 'success');
  assert.equal(out.vitalsRecovered, true);
  assert.equal(out.lbSynced, true);
  assert.deepEqual(out.vitals, { ram: 22.5, cpu: 3.1, gpu: 11 });
  assert.equal(out.durationSeconds, 2); // one 2s health poll on the virtual clock
});

test('shared-only node sends exclusiveServices: []', async () => {
  const h = createHarness();
  await h.remediator.remediate('machine-2');
  assert.deepEqual(h.calls[0].body.exclusiveServices, []);
});

test('health polling waits through 503 draining / connection refused until 200', async () => {
  let n = 0;
  const h = createHarness({
    http: {
      health: () => {
        n += 1;
        if (n === 1) throw connRefused();
        return n < 4 ? 503 : 200;
      },
    },
  });
  const out = await h.remediator.remediate('machine-1');
  assert.equal(out.result, 'success');
  assert.equal(h.calls.filter((c) => c.type === 'get.health').length, 4);
  assert.equal(out.durationSeconds, 8);
});

test('container not found: REBOOTING then ONLINE, no restart', async () => {
  const h = createHarness({ docker: { names: ['machine-2'] } });
  const out = await h.remediator.remediate('machine-1');
  assert.equal(out.result, 'container_not_found');
  assert.deepEqual(types(h.calls), ['lb.REBOOTING', 'docker.list', 'lb.ONLINE']);
});

test('D1: restart() throws -> LB kept REBOOTING with retry reason, rejects restart_failed', async () => {
  const h = createHarness({ docker: { restartError: new Error('socket hang up') } });
  await assert.rejects(h.remediator.remediate('machine-1'), (err) => err.result === 'restart_failed');

  assertHandshakeBeforeRestart(h.calls);
  const lb = h.calls.filter((c) => c.type === 'lb');
  assert.equal(lb.length, 2);
  assert.equal(lb[1].body.status, 'REBOOTING');
  assert.equal(lb[1].body.etaSeconds, 60);
  assert.match(lb[1].body.reason, /^Remediation failed: .*socket hang up - retrying$/);
  assert.ok(!lb.some((c) => c.body.status === 'ONLINE'), 'must not route traffic to a node that failed to restart');
});

test('D1: /health never 200 -> health_timeout, LB left REBOOTING (not ONLINE)', async () => {
  const h = createHarness({ http: { health: () => 503 } });
  await assert.rejects(h.remediator.remediate('machine-1'), (err) => {
    assert.equal(err.result, 'health_timeout');
    assert.match(err.message, /did not become healthy within 90s/);
    return true;
  });
  const lb = h.calls.filter((c) => c.type === 'lb').map((c) => c.body.status);
  assert.deepEqual(lb, ['REBOOTING', 'REBOOTING']);
  assert.equal(h.calls.filter((c) => c.type === 'get.health').length, 45); // 90s / 2s
});

test('D2: LB unreachable -> node is still restarted, lb_unreachable counted', async () => {
  const h = createHarness({
    http: {
      lb: () => {
        throw connRefused();
      },
    },
  });
  const out = await h.remediator.remediate('machine-3');

  assertHandshakeBeforeRestart(h.calls);
  assert.equal(h.calls.filter((c) => c.type === 'docker.restart').length, 1);
  assert.equal(out.result, 'success');
  assert.equal(out.lbSynced, false);
  // 3 REBOOTING attempts, restart, then 3 ONLINE attempts
  assert.deepEqual(
    h.calls.filter((c) => c.type === 'lb').map((c) => c.body.status),
    ['REBOOTING', 'REBOOTING', 'REBOOTING', 'ONLINE', 'ONLINE', 'ONLINE'],
  );
  const text = await h.remediator.register.metrics();
  assert.match(text, /remediation_total\{machine_id="machine-3",result="lb_unreachable"\} 1/);
  assert.match(text, /remediation_total\{machine_id="machine-3",result="success"\} 1/);
});

test('LB recovers on 2nd attempt -> single extra retry, no lb_unreachable', async () => {
  let n = 0;
  const h = createHarness({
    http: {
      lb: () => {
        n += 1;
        if (n === 1) throw connRefused();
      },
    },
  });
  const out = await h.remediator.remediate('machine-1');
  assert.equal(out.lbSynced, true);
  assert.doesNotMatch(await h.remediator.register.metrics(), /lb_unreachable/);
});

test('D3: missing gpu metric line is not treated as recovered', async () => {
  const h = createHarness({ http: { metrics: (id) => metricsText(id, { gpu: null }) } });
  const out = await h.remediator.remediate('machine-1');
  assert.equal(out.result, 'success'); // healthy node is still put back online
  assert.equal(out.vitalsRecovered, false);
  assert.equal(out.vitals.gpu, null);
  assert.ok(h.logs.some((l) => l.level === 'warn' && /vitals not confirmed/.test(l.msg)));
});

test('vitals still high after restart -> success but vitalsRecovered false', async () => {
  const h = createHarness({ http: { metrics: (id) => metricsText(id, { ram: 89.5 }) } });
  const out = await h.remediator.remediate('machine-1');
  assert.equal(out.vitalsRecovered, false);
  assert.equal(out.vitals.ram, 89.5);
});

test('readGauges parses scientific notation and labels', async () => {
  const h = createHarness({ http: { metrics: () => 'node_ram_usage_percent{machine_id="machine-1",x="y"} 4.2e1\nnode_cpu_load_percent{machine_id="machine-1"} 0\nnode_gpu_utilization_percent{machine_id="machine-1"} 12.75' } });
  assert.deepEqual(await h.remediator.readGauges('machine-1'), { ram: 42, cpu: 0, gpu: 12.75 });
});

test('findContainer falls back to compose-style names', async () => {
  const calls = [];
  const { createRemediator } = require('../src/dockerController');
  const r = createRemediator({
    http: {},
    logger: () => {},
    docker: {
      listContainers: async () => [{ Id: 'abc', Names: ['/self-healing-system-machine-4-1'], Labels: {} }],
      getContainer: (id) => {
        calls.push(id);
        return { id };
      },
    },
  });
  assert.deepEqual(await r.findContainer('machine-4'), { id: 'abc' });
  assert.equal(await r.findContainer('machine-1'), null); // machine-1 must not match machine-14 etc.
});

test('success records MTTR histogram and last-duration gauge', async () => {
  const h = createHarness();
  await h.remediator.remediate('machine-1');
  const text = await h.remediator.register.metrics();
  assert.match(text, /remediation_duration_seconds_count\{machine_id="machine-1"\} 1/);
  assert.match(text, /remediation_last_duration_seconds\{machine_id="machine-1"\} 2/);
});
