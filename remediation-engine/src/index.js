'use strict';

const express = require('express');
const { remediate, register, remediationTotal, log } = require('./dockerController');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_SECONDS, 10) || 45) * 1000;
const MACHINE_ID_PATTERN = /^machine-[1-9][0-9]*$/;

const cooldownMap = new Map(); // machineId -> epoch ms of last remediation start/finish
const inFlight = new Set(); // machines currently being remediated
const history = []; // last 25 outcomes for GET /status

function record(entry) {
  history.unshift({ at: new Date().toISOString(), ...entry });
  if (history.length > 25) history.pop();
}

function extractMachineId(alert) {
  const labels = alert.labels || {};
  const raw = labels.machine_id || (labels.instance ? String(labels.instance).split(':')[0] : null);
  return raw && MACHINE_ID_PATTERN.test(raw) ? raw : null;
}

async function runRemediation(machineId, alertnames) {
  inFlight.add(machineId);
  try {
    const outcome = await remediate(machineId, { alerts: alertnames });
    record(outcome);
  } catch (err) {
    log('error', `Remediation failed for ${machineId}`, { machineId, error: err.message });
    remediationTotal.inc({ machine_id: machineId, result: 'failed' });
    record({ machineId, result: 'failed', error: err.message });
    cooldownMap.delete(machineId); // let the next Alertmanager repeat retry immediately
  } finally {
    inFlight.delete(machineId);
    if (cooldownMap.has(machineId)) cooldownMap.set(machineId, Date.now());
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Alertmanager webhook (Contract B). /api/v1/remediate is kept as an alias.
function webhookHandler(req, res) {
  const alerts = Array.isArray(req.body && req.body.alerts) ? req.body.alerts : [];
  const firing = alerts.filter((a) => a && a.status === 'firing');

  const byMachine = new Map();
  for (const alert of firing) {
    const machineId = extractMachineId(alert);
    if (!machineId) {
      log('warn', 'firing alert without a valid machine id - ignored', { labels: alert.labels });
      continue;
    }
    if (!byMachine.has(machineId)) byMachine.set(machineId, []);
    byMachine.get(machineId).push((alert.labels || {}).alertname || 'unknown');
  }

  const accepted = [];
  const skipped = [];
  for (const [machineId, alertnames] of byMachine) {
    const last = cooldownMap.get(machineId) || 0;
    const sinceMs = Date.now() - last;
    if (inFlight.has(machineId)) {
      log('info', `${machineId}: remediation already in progress - skipped`, { machineId });
      skipped.push({ machineId, reason: 'in_progress' });
    } else if (sinceMs < COOLDOWN_MS) {
      log('info', `${machineId}: cooldown active (${Math.ceil((COOLDOWN_MS - sinceMs) / 1000)}s left) - skipped`, { machineId });
      skipped.push({ machineId, reason: 'cooldown', cooldownRemainingSeconds: Math.ceil((COOLDOWN_MS - sinceMs) / 1000) });
    } else {
      cooldownMap.set(machineId, Date.now());
      accepted.push(machineId);
      runRemediation(machineId, alertnames); // async: Alertmanager must not wait for the restart
    }
  }

  log('info', 'webhook processed', { received: alerts.length, firing: firing.length, accepted, skipped });
  res.status(202).json({ ok: true, accepted, skipped });
}

app.post('/webhook', webhookHandler);
app.post('/api/v1/remediate', webhookHandler);

app.get('/health', (req, res) => res.json({ status: 'healthy', service: 'remediation-engine' }));

app.get('/status', (req, res) => {
  const cooldowns = {};
  for (const [id, ts] of cooldownMap) cooldowns[id] = Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - ts)) / 1000));
  res.json({ inFlight: [...inFlight], cooldownSecondsRemaining: cooldowns, history });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

app.listen(PORT, '0.0.0.0', () => {
  log('info', `remediation-engine listening on :${PORT}`, { cooldownSeconds: COOLDOWN_MS / 1000 });
});
