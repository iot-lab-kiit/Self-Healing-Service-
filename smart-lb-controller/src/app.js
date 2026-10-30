'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axiosLib = require('axios');
const { createRegistry } = require('./stateRegistry');

const waitingTemplate = fs.readFileSync(path.join(__dirname, 'views', 'waitingScreen.html'), 'utf8');

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'smart-lb-controller', msg, ...extra }));
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// JSON that is safe to place inside an inline <script> (cannot close the tag or break the string)
const jsonForScript = (v) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

/**
 * Build the Express app. Everything with side effects (state, upstream HTTP client, clock, logger) is injectable.
 */
function createApp({
  now = Date.now,
  registry = createRegistry({ now }),
  // Upstream calls are cluster-internal and must bypass any container-level HTTP proxy
  http = axiosLib.create({ proxy: false }),
  exclusiveMachine = 'machine-1',
  gpuUpstream = `http://${exclusiveMachine}:3000`,
  upstreamTimeoutMs = 5000,
  logger = log,
} = {}) {
  function renderWaitingScreen(state) {
    const total = state.etaSeconds || 30;
    const elapsed = state.rebootStartedAt ? Math.max(0, (now() - state.rebootStartedAt) / 1000) : 0;
    const values = {
      MACHINE_ID: escapeHtml(state.machineId),
      MACHINE_ID_JSON: jsonForScript(state.machineId),
      REASON: escapeHtml(state.reason || 'Automated self-healing restart'),
      REMAINING_SECONDS: String(state.remainingSeconds),
      TOTAL_SECONDS: String(total),
      ELAPSED_SECONDS: elapsed.toFixed(1),
      REBOOT_STARTED_AT: jsonForScript(state.rebootStartedAt),
    };
    // Single pass with a replacer function: values are never re-scanned and `$&`-style patterns stay literal
    return waitingTemplate.replace(/{{(\w+)}}/g, (m, key) => (Object.hasOwn(values, key) ? values[key] : m));
  }

  // CORS only for read-only GET routes; /internal/node-status must not be callable from arbitrary web pages
  const readCors = cors({ methods: ['GET'] });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path !== '/health') logger('info', `${req.method} ${req.originalUrl}`);
    next();
  });

  app.get('/health', readCors, (req, res) => res.json({ status: 'healthy', service: 'smart-lb-controller' }));

  // Contract C: pre-reboot and post-recovery handshake from the Remediation Engine
  app.post('/internal/node-status', (req, res) => {
    const result = registry.update(req.body);
    if (!result.ok) {
      logger('warn', 'rejected node-status update', { error: result.error, body: req.body });
      return res.status(400).json({ error: result.error });
    }
    logger('info', `${result.state.machineId} -> ${result.state.status}`, {
      machineId: result.state.machineId,
      status: result.state.status,
      reason: result.state.reason,
      etaSeconds: result.state.etaSeconds,
    });
    return res.json({ ok: true, state: result.state });
  });

  app.get('/cluster-status', readCors, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(registry.snapshot());
  });

  // Exclusive service: only machine-1 hosts it, so the LB must never hang or 502 during a reboot
  app.get('/api/gpu-render', readCors, async (req, res) => {
    const state = registry.get(exclusiveMachine);

    if (state && state.status === 'REBOOTING') {
      res.status(503).set({ 'Retry-After': String(state.remainingSeconds), 'Cache-Control': 'no-store', 'X-Smart-LB': 'intercepted' });
      // Browsers prefer HTML; curl and API clients (Accept: */* or application/json) get JSON
      if (req.accepts(['json', 'html']) === 'html') {
        return res.type('html').send(renderWaitingScreen(state));
      }
      return res.json({
        error: 'Service Temporarily Rebooting',
        machineId: state.machineId,
        reason: state.reason,
        retryAfterSeconds: state.remainingSeconds,
      });
    }

    try {
      const upstream = await http.get(`${gpuUpstream}/api/gpu-render`, {
        timeout: upstreamTimeoutMs,
        // Hard overall deadline: `timeout` alone only covers socket inactivity, not a slowly trickling body
        signal: AbortSignal.timeout(upstreamTimeoutMs),
        responseType: 'text',
        transformResponse: (d) => d,
        validateStatus: () => true,
      });
      res.status(upstream.status).set({
        'Content-Type': upstream.headers['content-type'] || 'application/json',
        'X-Smart-LB': 'proxied',
        'X-Served-By': exclusiveMachine,
      });
      return res.send(upstream.data);
    } catch (err) {
      logger('error', `upstream ${exclusiveMachine} unreachable`, { error: err.code || err.message });
      return res.status(503).set({ 'Retry-After': '5', 'Cache-Control': 'no-store', 'X-Smart-LB': 'upstream-error' }).json({
        error: 'Upstream Unavailable',
        machineId: exclusiveMachine,
        detail: err.code || err.message,
        retryAfterSeconds: 5,
      });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

  // JSON errors only (malformed/oversized bodies, unexpected throws); never leak stack traces
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) logger('error', 'unhandled error', { error: err.message });
    return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
  });

  return app;
}

module.exports = { createApp, escapeHtml, jsonForScript, log };
