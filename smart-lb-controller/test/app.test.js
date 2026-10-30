'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { createRegistry } = require('../src/stateRegistry');

const T0 = 1_700_000_000_000;
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const REBOOT = {
  machineId: 'machine-1',
  status: 'REBOOTING',
  reason: 'Sustained Resource Exhaustion (>85% for >=60s)',
  exclusiveServices: ['gpu-render'],
  etaSeconds: 30,
};
const UPSTREAM_BODY = { machineId: 'machine-1', service: 'gpu-renderer', status: 'Rendered Frame' };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

// Fake machine-1: records request paths, answers /api/gpu-render with JSON
function fakeUpstream() {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(UPSTREAM_BODY));
  });
  return { server, paths };
}

// Starts the LB with an injectable clock; returns helpers bound to it
async function startLb(opts = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const app = createApp({ now, registry: createRegistry({ now }), logger: () => {}, ...opts });
  const server = http.createServer(app);
  const base = await listen(server);
  const post = (body, raw) =>
    fetch(`${base}/internal/node-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw !== undefined ? raw : JSON.stringify(body),
    });
  // Client-side deadline so a regression fails the test instead of hanging the run
  const gpu = (accept, path = '/api/gpu-render') =>
    fetch(`${base}${path}`, { headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(3000) });
  return { base, clock, server, post, gpu, close: () => close(server) };
}

describe('POST /internal/node-status', () => {
  let lb;
  beforeEach(async () => {
    if (lb) await lb.close();
    lb = await startLb({ gpuUpstream: 'http://127.0.0.1:1' });
  });
  after(() => lb.close());

  test('REBOOTING payload is accepted and stores etaTimestamp = now + eta*1000', async () => {
    const res = await lb.post(REBOOT);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state.machineId, 'machine-1');
    assert.equal(body.state.status, 'REBOOTING');
    assert.equal(body.state.reason, REBOOT.reason);
    assert.equal(body.state.etaSeconds, 30);
    assert.equal(body.state.rebootStartedAt, T0);
    assert.equal(body.state.etaTimestamp, T0 + 30_000);
    assert.equal(body.state.remainingSeconds, 30);
    assert.deepEqual(body.state.exclusiveServices, ['gpu-render']);
  });

  test('ONLINE payload clears reboot fields', async () => {
    await lb.post(REBOOT);
    const res = await lb.post({ machineId: 'machine-1', status: 'ONLINE' });
    assert.equal(res.status, 200);
    const { state } = await res.json();
    assert.equal(state.status, 'ONLINE');
    assert.equal(state.reason, null);
    assert.equal(state.etaTimestamp, null);
    assert.equal(state.remainingSeconds, 0);
  });

  const invalid = [
    ['unknown machine', { machineId: 'machine-9', status: 'REBOOTING' }],
    ['invalid status', { machineId: 'machine-1', status: 'FAILED' }],
    ['missing status', { machineId: 'machine-1' }],
    ['__proto__ machineId', { machineId: '__proto__', status: 'ONLINE' }],
    ['constructor machineId', { machineId: 'constructor', status: 'ONLINE' }],
    ['non-string machineId', { machineId: { toString: 1 }, status: 'ONLINE' }],
    ['empty object', {}],
  ];
  for (const [name, body] of invalid) {
    test(`400 for ${name}`, async () => {
      const res = await lb.post(body);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(typeof (await res.json()).error, 'string');
    });
  }

  const badBodies = [
    ['missing body', ''],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON array', '[{"machineId":"machine-1","status":"ONLINE"}]'],
    ['malformed JSON', '{"machineId":'],
  ];
  for (const [name, raw] of badBodies) {
    test(`400 JSON for ${name}`, async () => {
      const res = await lb.post(null, raw);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.equal(typeof body.error, 'string');
      assert.doesNotMatch(JSON.stringify(body), /at .*\.js/); // no stack trace
    });
  }

  test('__proto__ key in body does not pollute Object.prototype', async () => {
    const res = await lb.post(null, '{"__proto__":{"polluted":true},"machineId":"machine-2","status":"ONLINE"}');
    assert.equal(res.status, 200);
    assert.equal({}.polluted, undefined);
  });

  test('oversized body -> 413 JSON', async () => {
    const res = await lb.post({ ...REBOOT, reason: 'x'.repeat(200 * 1024) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, 'Request body too large');
  });

  for (const eta of [-5, 'abc', 0, null]) {
    test(`etaSeconds ${JSON.stringify(eta)} falls back to the default 30 (REBOOTING is never rejected)`, async () => {
      const res = await lb.post({ ...REBOOT, etaSeconds: eta });
      assert.equal(res.status, 200);
      const { state } = await res.json();
      assert.equal(state.etaSeconds, 30);
      assert.equal(state.etaTimestamp, T0 + 30_000);
    });
  }

  test('huge etaSeconds is capped so Retry-After stays a finite integer', async () => {
    await lb.post({ ...REBOOT, etaSeconds: 1e308 });
    const res = await lb.gpu('application/json');
    assert.equal(res.headers.get('retry-after'), '3600');
    assert.equal((await res.json()).retryAfterSeconds, 3600);
  });

  test('non-string reason falls back to the default instead of breaking rendering', async () => {
    const res = await lb.post({ ...REBOOT, reason: { toString: 1 } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state.reason, 'Automated self-healing restart');
    const page = await lb.gpu(BROWSER_ACCEPT);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /Automated self-healing restart/);
  });
});

describe('GET /api/gpu-render while machine-1 is REBOOTING', () => {
  let lb;
  before(async () => {
    lb = await startLb({ gpuUpstream: 'http://127.0.0.1:1' });
    await lb.post(REBOOT);
  });
  after(() => lb.close());

  test('Accept: application/json -> 503 + Retry-After + exact JSON body', async () => {
    const res = await lb.gpu('application/json');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {
      error: 'Service Temporarily Rebooting',
      machineId: 'machine-1',
      reason: REBOOT.reason,
      retryAfterSeconds: 30,
    });
  });

  test('curl default Accept: */* -> JSON', async () => {
    const res = await lb.gpu('*/*');
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.json()).error, 'Service Temporarily Rebooting');
  });

  test('browser Accept -> 503 waiting screen with machine id, escaped reason and countdown', async () => {
    const res = await lb.gpu(BROWSER_ACCEPT);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<b>machine-1<\/b> is rebooting/);
    assert.ok(html.includes('Sustained Resource Exhaustion (&gt;85% for &gt;=60s)'));
    assert.match(html, /<span id="seconds">30<\/span>/);
    assert.match(html, /var MACHINE_ID = "machine-1";/);
    assert.match(html, new RegExp(`var STARTED_AT = ${T0};`));
    assert.doesNotMatch(html, /{{\w+}}/);
  });

  test('inline script of the waiting screen is valid JavaScript', async () => {
    const html = await (await lb.gpu(BROWSER_ACCEPT)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
  });

  test('remainingSeconds uses ceil with a floor of 1 (injected clock)', async () => {
    lb.clock.t = T0 + 17_700; // 12.3 s left
    let res = await lb.gpu('application/json');
    assert.equal(res.headers.get('retry-after'), '13');
    assert.equal((await res.json()).retryAfterSeconds, 13);

    lb.clock.t = T0 + 30_000; // exactly at ETA
    res = await lb.gpu('application/json');
    assert.equal(res.headers.get('retry-after'), '1');

    lb.clock.t = T0 + 120_000; // well past ETA
    res = await lb.gpu('application/json');
    assert.equal(res.headers.get('retry-after'), '1');
    assert.equal((await res.json()).retryAfterSeconds, 1);
    const html = await (await lb.gpu(BROWSER_ACCEPT)).text();
    assert.match(html, /<span id="seconds">1<\/span>/);
  });

  test('REBOOTING re-sent with etaSeconds 60 after a failure resets the countdown', async () => {
    lb.clock.t = T0 + 45_000;
    const reason = 'Remediation failed: connect ECONNREFUSED - retrying';
    const post = await lb.post({ machineId: 'machine-1', status: 'REBOOTING', reason, etaSeconds: 60 });
    assert.equal(post.status, 200);
    const res = await lb.gpu('application/json');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.deepEqual(await res.json(), {
      error: 'Service Temporarily Rebooting',
      machineId: 'machine-1',
      reason,
      retryAfterSeconds: 60,
    });
    const html = await (await lb.gpu(BROWSER_ACCEPT)).text();
    assert.match(html, /<span id="seconds">60<\/span>/);
    assert.match(html, new RegExp(`var STARTED_AT = ${T0 + 45_000};`)); // open pages see a new rebootStartedAt and reload
    assert.ok(html.includes(reason));
  });
});

describe('XSS / template injection in reason', () => {
  let lb;
  before(async () => {
    lb = await startLb({ gpuUpstream: 'http://127.0.0.1:1' });
  });
  after(() => lb.close());

  test('<script> in reason is stored raw but rendered escaped', async () => {
    const reason = '<script>alert(1)</script>"\'&';
    await lb.post({ ...REBOOT, reason });
    const status = await (await fetch(`${lb.base}/cluster-status`)).json();
    assert.equal(status.machines['machine-1'].reason, reason);

    const html = await (await lb.gpu(BROWSER_ACCEPT)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
    assert.equal(html.match(/<script>/g).length, 1); // only the page's own script
  });

  test('$-replacement patterns and {{placeholders}} in reason are rendered literally', async () => {
    const reason = "cost $& $' $` $1 {{REMAINING_SECONDS}}";
    await lb.post({ ...REBOOT, reason });
    const html = await (await lb.gpu(BROWSER_ACCEPT)).text();
    assert.ok(html.includes('cost $&amp; $&#39; $` $1 {{REMAINING_SECONDS}}'));
    assert.equal(html.match(/<!DOCTYPE html>/g).length, 1);
    assert.equal(html.match(/<script>/g).length, 1);
  });
});

describe('GET /api/gpu-render while machine-1 is ONLINE', () => {
  test('proxies to the fixed upstream and returns its response', async () => {
    const up = fakeUpstream();
    const upBase = await listen(up.server);
    const lb = await startLb({ gpuUpstream: upBase });
    try {
      await lb.post(REBOOT);
      await lb.post({ machineId: 'machine-1', status: 'ONLINE' });
      const res = await lb.gpu('application/json', '/api/gpu-render?target=http://evil.example/');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-smart-lb'), 'proxied');
      assert.equal(res.headers.get('x-served-by'), 'machine-1');
      assert.deepEqual(await res.json(), UPSTREAM_BODY);
      assert.deepEqual(up.paths, ['/api/gpu-render']); // target is fixed, request input is not forwarded
    } finally {
      await lb.close();
      await close(up.server);
    }
  });

  test('ignores HTTP proxy env vars (axios created with proxy: false)', async () => {
    const up = fakeUpstream();
    const upBase = await listen(up.server);
    const lb = await startLb({ gpuUpstream: upBase });
    const saved = {};
    for (const k of ['http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']) saved[k] = process.env[k];
    process.env.http_proxy = process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
    try {
      const res = await lb.gpu('application/json');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), UPSTREAM_BODY);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await lb.close();
      await close(up.server);
    }
  });

  test('upstream down (connection refused) -> clean 503 JSON', async () => {
    const dead = http.createServer();
    const deadBase = await listen(dead);
    await close(dead);
    const lb = await startLb({ gpuUpstream: deadBase });
    try {
      const res = await lb.gpu(BROWSER_ACCEPT);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '5');
      const body = await res.json();
      assert.equal(body.error, 'Upstream Unavailable');
      assert.equal(body.machineId, 'machine-1');
      assert.equal(body.retryAfterSeconds, 5);
    } finally {
      await lb.close();
    }
  });

  test('upstream hangs -> 503 JSON after the timeout, no hang', async () => {
    const hang = http.createServer(() => {}); // never responds
    const hangBase = await listen(hang);
    const lb = await startLb({ gpuUpstream: hangBase, upstreamTimeoutMs: 200 });
    try {
      const started = Date.now();
      const res = await lb.gpu('application/json');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'Upstream Unavailable');
      assert.ok(Date.now() - started < 2000);
    } finally {
      await lb.close();
      await close(hang);
    }
  });

  test('upstream trickles a body forever -> overall deadline still applies', async () => {
    const trickle = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const iv = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(iv));
    });
    const base = await listen(trickle);
    const lb = await startLb({ gpuUpstream: base, upstreamTimeoutMs: 300 });
    try {
      const started = Date.now();
      const res = await lb.gpu('application/json');
      assert.equal(res.status, 503);
      assert.ok(Date.now() - started < 2000);
    } finally {
      await lb.close();
      await close(trickle);
    }
  });

  test('injected http client is called with the fixed URL and a timeout', async () => {
    const calls = [];
    const fakeHttp = {
      get: async (url, cfg) => {
        calls.push({ url, cfg });
        return { status: 200, headers: { 'content-type': 'application/json' }, data: '{"ok":true}' };
      },
    };
    const lb = await startLb({ http: fakeHttp, gpuUpstream: 'http://machine-1:3000' });
    try {
      const res = await lb.gpu('application/json', '/api/gpu-render?x=1');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://machine-1:3000/api/gpu-render');
      assert.equal(calls[0].cfg.timeout, 5000);
      assert.ok(calls[0].cfg.signal instanceof AbortSignal);
    } finally {
      await lb.close();
    }
  });
});

describe('cluster-status, CORS and routing', () => {
  let lb;
  before(async () => {
    lb = await startLb({ gpuUpstream: 'http://127.0.0.1:1' });
    await lb.post(REBOOT);
  });
  after(() => lb.close());

  test('GET /cluster-status -> all 5 machines, no-store', async () => {
    const res = await fetch(`${lb.base}/cluster-status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.timestamp, new Date(T0).toISOString());
    assert.deepEqual(Object.keys(body.machines), ['machine-1', 'machine-2', 'machine-3', 'machine-4', 'machine-5']);
    for (const [id, m] of Object.entries(body.machines)) {
      assert.equal(m.machineId, id);
      for (const k of ['status', 'reason', 'etaSeconds', 'etaTimestamp', 'rebootStartedAt', 'exclusiveServices', 'updatedAt', 'remainingSeconds']) {
        assert.ok(k in m, `${id} missing ${k}`);
      }
    }
    assert.equal(body.machines['machine-1'].status, 'REBOOTING');
    assert.equal(body.machines['machine-1'].remainingSeconds, 30);
    assert.equal(body.machines['machine-2'].status, 'ONLINE');
  });

  test('CORS allowed for GET /cluster-status', async () => {
    const res = await fetch(`${lb.base}/cluster-status`, { headers: { Origin: 'http://dashboard.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('CORS preflight for POST /internal/node-status is not granted', async () => {
    const res = await fetch(`${lb.base}/internal/node-status`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('GET /health', async () => {
    const res = await fetch(`${lb.base}/health`);
    assert.deepEqual(await res.json(), { status: 'healthy', service: 'smart-lb-controller' });
  });

  test('unknown route -> 404 JSON', async () => {
    const res = await fetch(`${lb.base}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not Found', path: '/nope' });
  });
});
