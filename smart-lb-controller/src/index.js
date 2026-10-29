'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axiosLib = require('axios');
const registry = require('./stateRegistry');

// Upstream calls are cluster-internal and must bypass any container-level HTTP proxy
const axios = axiosLib.create({ proxy: false });

const PORT = parseInt(process.env.PORT, 10) || 5000;
const EXCLUSIVE_MACHINE = process.env.EXCLUSIVE_MACHINE || 'machine-1';
const GPU_UPSTREAM = process.env.GPU_UPSTREAM || `http://${EXCLUSIVE_MACHINE}:3000`;

const waitingTemplate = fs.readFileSync(path.join(__dirname, 'views', 'waitingScreen.html'), 'utf8');

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'smart-lb-controller', msg, ...extra }));
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderWaitingScreen(state) {
  const total = state.etaSeconds || 30;
  const elapsed = state.rebootStartedAt ? Math.max(0, (Date.now() - state.rebootStartedAt) / 1000) : 0;
  return waitingTemplate
    .replace(/{{MACHINE_ID}}/g, escapeHtml(state.machineId))
    .replace(/{{REASON}}/g, escapeHtml(state.reason || 'Automated self-healing restart'))
    .replace(/{{REMAINING_SECONDS}}/g, String(state.remainingSeconds))
    .replace(/{{TOTAL_SECONDS}}/g, String(total))
    .replace(/{{ELAPSED_SECONDS}}/g, elapsed.toFixed(1));
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path !== '/health') log('info', `${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'healthy', service: 'smart-lb-controller' }));

// Contract C: pre-reboot and post-recovery handshake from the Remediation Engine
app.post('/internal/node-status', (req, res) => {
  const result = registry.update(req.body);
  if (!result.ok) {
    log('warn', 'rejected node-status update', { error: result.error, body: req.body });
    return res.status(400).json({ error: result.error });
  }
  log('info', `${result.state.machineId} -> ${result.state.status}`, {
    machineId: result.state.machineId,
    status: result.state.status,
    reason: result.state.reason,
    etaSeconds: result.state.etaSeconds,
  });
  return res.json({ ok: true, state: result.state });
});

app.get('/cluster-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(registry.snapshot());
});

// Exclusive service: only machine-1 hosts it, so the LB must never hang or 502 during a reboot
app.get('/api/gpu-render', async (req, res) => {
  const state = registry.get(EXCLUSIVE_MACHINE);

  if (state.status === 'REBOOTING') {
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
    const upstream = await axios.get(`${GPU_UPSTREAM}/api/gpu-render`, {
      timeout: 5000,
      responseType: 'text',
      transformResponse: (d) => d,
      validateStatus: () => true,
    });
    res.status(upstream.status).set({
      'Content-Type': upstream.headers['content-type'] || 'application/json',
      'X-Smart-LB': 'proxied',
      'X-Served-By': EXCLUSIVE_MACHINE,
    });
    return res.send(upstream.data);
  } catch (err) {
    log('error', `upstream ${EXCLUSIVE_MACHINE} unreachable`, { error: err.code || err.message });
    return res.status(503).set({ 'Retry-After': '5', 'X-Smart-LB': 'upstream-error' }).json({
      error: 'Upstream Unavailable',
      machineId: EXCLUSIVE_MACHINE,
      detail: err.code || err.message,
      retryAfterSeconds: 5,
    });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

app.listen(PORT, '0.0.0.0', () => {
  log('info', `smart-lb-controller listening on :${PORT}`, { exclusiveMachine: EXCLUSIVE_MACHINE, upstream: GPU_UPSTREAM });
});
