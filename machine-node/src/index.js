'use strict';

const express = require('express');
const cors = require('cors');
const m = require('./metrics');
const { router: faultRouter, resetAll } = require('./faultRoutes');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const EXCLUSIVE_SERVICE = String(process.env.EXCLUSIVE_SERVICE || 'false').toLowerCase() === 'true';

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, machineId: m.MACHINE_ID, msg, ...extra }));
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  if (m.state.draining) {
    return res.status(503).json({ status: 'draining', machineId: m.MACHINE_ID, uptime: process.uptime() });
  }
  return res.status(200).json({ status: 'healthy', machineId: m.MACHINE_ID, uptime: process.uptime() });
});

app.get('/api/shared', (req, res) => {
  res.status(200).json({
    machineId: m.MACHINE_ID,
    service: 'shared-api',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/gpu-render', (req, res) => {
  if (!EXCLUSIVE_SERVICE) {
    return res.status(404).json({ error: 'gpu-render is hosted exclusively on machine-1', machineId: m.MACHINE_ID });
  }
  return res.status(200).json({
    machineId: m.MACHINE_ID,
    service: 'gpu-renderer',
    status: 'Rendered Frame',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', m.register.contentType);
    res.end(await m.register.metrics());
  } catch (err) {
    res.status(500).end(String(err));
  }
});

app.use('/fault', faultRouter);

app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path, machineId: m.MACHINE_ID }));

const server = app.listen(PORT, '0.0.0.0', () => {
  m.startSamplers();
  log('info', `${m.MACHINE_ID} listening on :${PORT}`, {
    exclusiveService: EXCLUSIVE_SERVICE,
    simulateGpu: m.SIMULATE_GPU,
    memLimitMb: m.MEM_LIMIT_MB,
  });
});

server.on('connection', (socket) => {
  m.state.activeConnections += 1;
  socket.on('close', () => {
    m.state.activeConnections = Math.max(0, m.state.activeConnections - 1);
  });
});

// Graceful drain: /health flips to 503 so Traefik stops routing, then exit before Docker's SIGKILL (t=5s)
function shutdown(signal) {
  if (m.state.draining) return;
  m.state.draining = true;
  log('warn', `${signal} received - draining ${m.MACHINE_ID}`);
  resetAll();
  setTimeout(() => server.close(() => process.exit(0)), 1500).unref();
  setTimeout(() => process.exit(0), 3500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
