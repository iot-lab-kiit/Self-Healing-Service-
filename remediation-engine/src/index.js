'use strict';

const client = require('prom-client');
const { createRemediator } = require('./dockerController');
const { createApp } = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_SECONDS, 10) || 45) * 1000;
const MAX_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES, 10) || 3;

const remediator = createRemediator();
client.collectDefaultMetrics({ register: remediator.register });

const { app } = createApp({
  remediate: remediator.remediate,
  register: remediator.register,
  metrics: remediator.metrics,
  log: remediator.log,
  cooldownMs: COOLDOWN_MS,
  maxFailures: MAX_FAILURES,
});

app.listen(PORT, '0.0.0.0', () => {
  remediator.log('info', `remediation-engine listening on :${PORT}`, { cooldownSeconds: COOLDOWN_MS / 1000, maxFailures: MAX_FAILURES });
});
