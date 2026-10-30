'use strict';

// A 16MB "container" keeps real test allocations small; env is read at require time
process.env.MACHINE_ID = 'machine-1';
process.env.CONTAINER_MEM_LIMIT_MB = '16';

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

mock.method(console, 'log', () => {}); // silence structured fault logs

const { createApp } = require('../src/index');
const m = require('../src/metrics');
const { resetAll, leak } = require('../src/faultRoutes');

const MB = 1024 * 1024;
const BASE_RSS = 2 * MB;
const TARGET = m.MEM_LIMIT_BYTES * m.MEM_TARGET_RATIO;
const realRss = m.mem.rss;

let server;
let base;

async function readRam() {
  const text = await (await fetch(`${base}/metrics`)).text();
  const match = text.match(/^node_ram_usage_percent\{machine_id="machine-1"\} (\S+)$/m);
  assert.ok(match, 'node_ram_usage_percent missing');
  return Number(match[1]);
}

const post = (path) => fetch(`${base}${path}`, { method: 'POST' });

function tick(t, times) {
  for (let i = 0; i < times; i += 1) t.mock.timers.tick(500);
}

before(async () => {
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  resetAll();
  m.mem.rss = realRss;
});

after(async () => {
  resetAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('POST /fault/memory plateaus at 88-90% and a second call does not allocate more', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  m.mem.rss = () => BASE_RSS + leak.bytes; // RSS tracks the leaked buffers

  let res = await post('/fault/memory');
  assert.equal(res.status, 202);
  assert.equal((await res.json()).started, true);

  tick(t, 10);
  assert.equal(m.state.memoryPlateaued, true);
  const leaked = leak.bytes;
  assert.ok(leaked <= TARGET - BASE_RSS, `leaked ${leaked}`);
  assert.ok(m.mem.rss() >= TARGET - MB, 'should reach the plateau band');

  const ram = await readRam();
  assert.ok(ram >= 88 && ram <= 90, `ram ${ram}`);

  res = await post('/fault/memory');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).started, false);
  tick(t, 10);
  assert.equal(leak.bytes, leaked);
  assert.ok(m.mem.rss() / m.MEM_LIMIT_BYTES <= 0.9, 'real usage must stay at or below 90% of the limit');
  assert.ok((await readRam()) <= 90);
});

test('POST /fault/memory stays bounded even if RSS does not reflect the allocations', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  m.mem.rss = () => BASE_RSS; // e.g. lazily committed pages

  assert.equal((await post('/fault/memory')).status, 202);
  tick(t, 20);
  assert.equal(m.state.memoryPlateaued, true);
  assert.ok(leak.bytes <= TARGET, `leaked ${leak.bytes} > target ${TARGET}`);
  const ram = await readRam();
  assert.ok(ram >= 88 && ram <= 90, `ram ${ram}`);
});

test('POST /fault/reset releases leaked buffers and memory can be injected again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  m.mem.rss = () => BASE_RSS + leak.bytes;

  assert.equal((await post('/fault/memory')).status, 202);
  tick(t, 10);
  assert.ok(leak.chunks.length > 0);

  const res = await post('/fault/reset');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.faults.memory, false);
  assert.equal(body.memoryPlateaued, false);
  assert.equal(leak.chunks.length, 0);
  assert.equal(leak.bytes, 0);
  assert.equal(leak.timer, null);
  assert.equal(await readRam(), 12.5); // back to BASE_RSS / 16MB

  assert.equal((await post('/fault/memory')).status, 202);
});
