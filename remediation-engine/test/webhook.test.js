'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, fixture, listen, postJson } = require('./fakes');

async function withServer(opts, fn) {
  const h = createHarness(opts);
  const srv = await listen(h.app);
  try {
    await fn(h, srv.url);
  } finally {
    await h.idle();
    await srv.close();
  }
}

const restarts = (h) => h.calls.filter((c) => c.type === 'docker.restart').map((c) => c.id);

test('firing RAM alert on machine-1 -> 202 accepted, one full remediation', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { ok: true, accepted: ['machine-1'], skipped: [] });
    await h.idle();
    assert.deepEqual(restarts(h), ['id-machine-1']);
    assert.equal(h.state.history[0].result, 'success');
  }));

test('/api/v1/remediate alias behaves the same', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/api/v1/remediate`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body.accepted, ['machine-1']);
  }));

test('RAM + GPU on the same node -> exactly one restart', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-gpu-machine1.json'));
    assert.deepEqual(res.body.accepted, ['machine-1']);
    await h.idle();
    assert.deepEqual(restarts(h), ['id-machine-1']);
  }));

test('two nodes in one payload -> both remediated', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('firing-multi-node.json'));
    assert.deepEqual(res.body.accepted, ['machine-2', 'machine-4']);
    await h.idle();
    assert.deepEqual(restarts(h).sort(), ['id-machine-2', 'id-machine-4']);
  }));

test('same alert again within 45s -> skipped with cooldown', () =>
  withServer({}, async (h, url) => {
    await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    await h.idle();
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body, {
      ok: true,
      accepted: [],
      skipped: [{ machineId: 'machine-1', reason: 'cooldown', cooldownRemainingSeconds: 45 }],
    });
    h.clock.advance(46000);
    const later = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(later.body.accepted, ['machine-1']);
  }));

test('second webhook while the restart is still running -> in_progress', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = createHarness({ app: { remediate: async (id) => { await gate; return { machineId: id, result: 'success' }; } } });
  const srv = await listen(h.app);
  try {
    await postJson(`${srv.url}/webhook`, fixture('firing-ram-machine1.json'));
    const res = await postJson(`${srv.url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body.skipped, [{ machineId: 'machine-1', reason: 'in_progress' }]);
    const status = await (await fetch(`${srv.url}/status`)).json();
    assert.deepEqual(status.inFlight, ['machine-1']);
  } finally {
    release();
    await h.idle();
    await srv.close();
  }
});

test('resolved-only payload -> nothing happens', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('resolved-only.json'));
    assert.deepEqual(res.body, { ok: true, accepted: [], skipped: [] });
    assert.equal(h.calls.length, 0);
  }));

test('cAdvisor alert (machine_id from label_replace) is accepted', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('cadvisor-label.json'));
    assert.deepEqual(res.body.accepted, ['machine-5']);
  }));

test('no machine_id label -> falls back to instance host', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('instance-fallback.json'));
    assert.deepEqual(res.body.accepted, ['machine-3']);
  }));

test('invalid / injected machine ids are ignored, Docker never touched', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, fixture('invalid-machine-ids.json'));
    assert.deepEqual(res.body, { ok: true, accepted: [], skipped: [] });
    assert.equal(h.calls.length, 0);
    assert.equal(h.logs.filter((l) => /without a valid machine id/.test(l.msg)).length, 4);
  }));

for (const [name, body] of [
  ['empty object', {}],
  ['alerts not an array', { alerts: 'machine-1' }],
  ['null alert entries', { alerts: [null, 42, 'x'] }],
]) {
  test(`garbage body (${name}) -> 202 empty`, () =>
    withServer({}, async (h, url) => {
      const res = await postJson(`${url}/webhook`, body);
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, { ok: true, accepted: [], skipped: [] });
    }));
}

test('malformed JSON -> 400 JSON error, not 500', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/webhook`, '{"alerts": [');
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  }));

test('failed remediation clears cooldown so the next repeat retries immediately', () =>
  withServer({ http: { health: () => 503 } }, async (h, url) => {
    await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    await h.idle();
    assert.equal(h.state.history[0].result, 'health_timeout');
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body.accepted, ['machine-1']);
  }));

test('D4: 3 consecutive failures open the circuit; /reset closes it', () =>
  withServer({ docker: { restartError: new Error('boom') } }, async (h, url) => {
    for (let i = 0; i < 3; i += 1) {
      const r = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
      assert.deepEqual(r.body.accepted, ['machine-1']);
      await h.idle();
    }
    const blocked = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(blocked.body.skipped, [{ machineId: 'machine-1', reason: 'circuit_open' }]);
    assert.equal(restarts(h).length, 3);

    const status = await (await fetch(`${url}/status`)).json();
    assert.deepEqual(status.circuits['machine-1'], { consecutiveFailures: 3, open: true });
    assert.match(await (await fetch(`${url}/metrics`)).text(), /remediation_circuit_open\{machine_id="machine-1"\} 1/);

    const reset = await postJson(`${url}/reset/machine-1`, {});
    assert.deepEqual(reset.body, { ok: true, machineId: 'machine-1' });
    const again = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(again.body.accepted, ['machine-1']);
  }));

test('D4: circuit closes by itself after the 10 min failure window', () =>
  withServer({ docker: { restartError: new Error('boom') } }, async (h, url) => {
    for (let i = 0; i < 3; i += 1) {
      await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
      await h.idle();
    }
    h.clock.advance(11 * 60 * 1000);
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body.accepted, ['machine-1']);
  }));

test('D4: a success in between resets the failure count', () => {
  let fail = true;
  const remediate = async (id) => {
    if (fail) throw Object.assign(new Error('x'), { result: 'restart_failed' });
    return { machineId: id, result: 'success' };
  };
  return withServer({ app: { remediate } }, async (h, url) => {
    for (const f of [true, true, false, true, true]) {
      fail = f;
      h.clock.advance(46000);
      await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
      await h.idle();
    }
    assert.equal(h.state.failures.get('machine-1').count, 2);
    const res = await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    assert.deepEqual(res.body.accepted, ['machine-1']);
  });
});

test('/reset rejects invalid ids', () =>
  withServer({}, async (h, url) => {
    const res = await postJson(`${url}/reset/..%2Fetc`, {});
    assert.equal(res.status, 400);
  }));

test('/health, /status, /metrics and 404', () =>
  withServer({}, async (h, url) => {
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'healthy', service: 'remediation-engine' });
    await postJson(`${url}/webhook`, fixture('firing-ram-machine1.json'));
    await h.idle();
    const status = await (await fetch(`${url}/status`)).json();
    assert.deepEqual(status.cooldownSecondsRemaining, { 'machine-1': 45 });
    assert.equal(status.history[0].machineId, 'machine-1');
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.match(metrics, /remediation_total\{machine_id="machine-1",result="success"\} 1/);
    const nf = await fetch(`${url}/nope`);
    assert.equal(nf.status, 404);
  }));
