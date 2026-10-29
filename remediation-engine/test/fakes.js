'use strict';

const fs = require('fs');
const path = require('path');
const { createRemediator } = require('../src/dockerController');
const { createApp } = require('../src/app');

const MACHINES = ['machine-1', 'machine-2', 'machine-3', 'machine-4', 'machine-5'];

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const metricsText = (id, { ram = 22.5, cpu = 3.1, gpu = 11 } = {}) =>
  [
    '# HELP node_ram_usage_percent RAM usage',
    ram === null ? '' : `node_ram_usage_percent{machine_id="${id}"} ${ram}`,
    cpu === null ? '' : `node_cpu_load_percent{machine_id="${id}"} ${cpu}`,
    gpu === null ? '' : `node_gpu_utilization_percent{machine_id="${id}"} ${gpu}`,
  ].join('\n');

function connRefused() {
  const err = new Error('connect ECONNREFUSED');
  err.code = 'ECONNREFUSED';
  return err;
}

// Virtual clock: sleep() advances time instantly, so 90s health timeouts finish in microseconds
function createClock(start = Date.parse('2026-10-30T10:00:00Z')) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, advance: (ms) => { clock.t += ms; } };
  return clock;
}

// Every observable side effect is pushed onto `calls`, so tests can assert ordering
function createFakeDocker(calls, { names = MACHINES, restartError = null } = {}) {
  return {
    async listContainers() {
      calls.push({ type: 'docker.list' });
      return names.map((n) => ({ Id: `id-${n}`, Names: [`/${n}`], Labels: { 'com.docker.compose.service': n } }));
    },
    getContainer(id) {
      return {
        async restart(opts) {
          calls.push({ type: 'docker.restart', id, opts });
          if (restartError) throw restartError;
        },
      };
    },
  };
}

/**
 * handlers.lb(body) -> throw to fail; handlers.health(id) -> status code or throw;
 * handlers.metrics(id) -> prometheus text or throw.
 */
function createFakeHttp(calls, handlers = {}) {
  const lb = handlers.lb || (() => {});
  const health = handlers.health || (() => 200);
  const metrics = handlers.metrics || ((id) => metricsText(id));
  return {
    async post(url, body) {
      calls.push({ type: 'lb', url, body });
      lb(body);
      return { status: 200, data: { ok: true } };
    },
    async get(url) {
      const m = url.match(/^http:\/\/([^:/]+):\d+\/(health|metrics)$/);
      if (!m) throw new Error(`unexpected GET ${url}`);
      const [, id, route] = m;
      calls.push({ type: `get.${route}`, id });
      if (route === 'health') return { status: health(id) };
      return { status: 200, data: metrics(id) };
    },
  };
}

const silent = () => {};

function createHarness({ http = {}, docker = {}, app = {} } = {}) {
  const calls = [];
  const logs = [];
  const clock = createClock();
  const logger = (level, msg, extra) => logs.push({ level, msg, ...extra });
  const remediator = createRemediator({
    http: createFakeHttp(calls, http),
    docker: createFakeDocker(calls, docker),
    sleep: clock.sleep,
    now: clock.now,
    logger,
  });
  const server = createApp({
    remediate: remediator.remediate,
    register: remediator.register,
    metrics: remediator.metrics,
    log: logger,
    now: clock.now,
    ...app,
  });
  return { calls, logs, clock, remediator, ...server };
}

// Start an app on an ephemeral port; returns { url, close }
async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

module.exports = {
  MACHINES,
  fixture,
  metricsText,
  connRefused,
  createClock,
  createFakeDocker,
  createFakeHttp,
  createHarness,
  listen,
  postJson,
  silent,
};
