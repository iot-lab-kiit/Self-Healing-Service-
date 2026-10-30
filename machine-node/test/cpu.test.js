'use strict';

// Own file = own process, so metrics.js is loaded fresh with no samplers running yet.
process.env.MACHINE_ID = 'machine-1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/metrics');

const burn = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* simulate startup work (require, express init) */ }
};

test('startup work is not reported as CPU load after a restart', () => {
  burn(150);
  m.startSamplers();
  assert.ok(m.cpuPercent() < 50, `first CPU reading was ${m.cpuPercent()}%`);
});
