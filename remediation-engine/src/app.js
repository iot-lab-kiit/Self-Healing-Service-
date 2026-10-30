'use strict';

const express = require('express');

const MACHINE_ID_PATTERN = /^machine-[1-9][0-9]*$/;

function extractMachineId(alert) {
  const labels = alert.labels || {};
  const raw = labels.machine_id || (labels.instance ? String(labels.instance).split(':')[0] : null);
  return raw && MACHINE_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * Webhook + status API. Returns the Express app plus its state and an idle() helper
 * that resolves once every background remediation has settled (used by tests).
 */
function createApp({
  remediate,
  register,
  metrics,
  log,
  cooldownMs = 45000,
  maxFailures = 3,
  failureWindowMs = 10 * 60 * 1000,
  now = Date.now,
}) {
  const cooldownMap = new Map(); // machineId -> epoch ms of last remediation start/finish
  const inFlight = new Set(); // machines currently being remediated
  const failures = new Map(); // machineId -> { count, firstAt } consecutive failures
  const history = []; // last 25 outcomes for GET /status
  const running = new Set();

  function record(entry) {
    history.unshift({ at: new Date(now()).toISOString(), ...entry });
    if (history.length > 25) history.pop();
  }

  function circuitOpen(machineId) {
    const f = failures.get(machineId);
    if (!f || f.count < maxFailures) return false;
    if (now() - f.firstAt > failureWindowMs) {
      closeCircuit(machineId);
      return false;
    }
    return true;
  }

  function closeCircuit(machineId) {
    failures.delete(machineId);
    metrics.circuitOpen.set({ machine_id: machineId }, 0);
  }

  function recordFailure(machineId) {
    const f = failures.get(machineId);
    const next = !f || now() - f.firstAt > failureWindowMs ? { count: 1, firstAt: now() } : { count: f.count + 1, firstAt: f.firstAt };
    failures.set(machineId, next);
    if (next.count >= maxFailures) {
      metrics.circuitOpen.set({ machine_id: machineId }, 1);
      log('error', `${machineId}: ${next.count} consecutive remediation failures - auto-remediation suspended, manual action required`, {
        machineId,
        failures: next.count,
      });
    }
  }

  async function runRemediation(machineId, alertnames) {
    inFlight.add(machineId);
    try {
      const outcome = await remediate(machineId, { alerts: alertnames });
      record(outcome);
      if (outcome.result === 'success') closeCircuit(machineId);
    } catch (err) {
      log('error', `Remediation failed for ${machineId}`, { machineId, error: err.message });
      record({ machineId, result: err.result || 'failed', error: err.message });
      recordFailure(machineId);
      cooldownMap.delete(machineId); // let the next Alertmanager repeat retry immediately
    } finally {
      inFlight.delete(machineId);
      if (cooldownMap.has(machineId)) cooldownMap.set(machineId, now());
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
      const sinceMs = now() - last;
      if (inFlight.has(machineId)) {
        log('info', `${machineId}: remediation already in progress - skipped`, { machineId });
        skipped.push({ machineId, reason: 'in_progress' });
      } else if (circuitOpen(machineId)) {
        log('warn', `${machineId}: circuit open after repeated failures - skipped (POST /reset/${machineId} to re-enable)`, { machineId });
        skipped.push({ machineId, reason: 'circuit_open' });
      } else if (sinceMs < cooldownMs) {
        const left = Math.ceil((cooldownMs - sinceMs) / 1000);
        log('info', `${machineId}: cooldown active (${left}s left) - skipped`, { machineId });
        skipped.push({ machineId, reason: 'cooldown', cooldownRemainingSeconds: left });
      } else {
        cooldownMap.set(machineId, now());
        accepted.push(machineId);
        // async: Alertmanager must not wait for the restart
        const p = runRemediation(machineId, alertnames).finally(() => running.delete(p));
        running.add(p);
      }
    }

    log('info', 'webhook processed', { received: alerts.length, firing: firing.length, accepted, skipped });
    res.status(202).json({ ok: true, accepted, skipped });
  }

  app.post('/webhook', webhookHandler);
  app.post('/api/v1/remediate', webhookHandler);

  // Manual override: re-enable auto-remediation for a node whose circuit opened
  app.post('/reset/:machineId', (req, res) => {
    const { machineId } = req.params;
    if (!MACHINE_ID_PATTERN.test(machineId)) return res.status(400).json({ error: 'invalid machine id' });
    closeCircuit(machineId);
    cooldownMap.delete(machineId);
    log('info', `${machineId}: circuit and cooldown reset manually`, { machineId });
    return res.json({ ok: true, machineId });
  });

  app.get('/health', (req, res) => res.json({ status: 'healthy', service: 'remediation-engine' }));

  app.get('/status', (req, res) => {
    const cooldowns = {};
    for (const [id, ts] of cooldownMap) cooldowns[id] = Math.max(0, Math.ceil((cooldownMs - (now() - ts)) / 1000));
    const circuits = {};
    for (const [id, f] of failures) circuits[id] = { consecutiveFailures: f.count, open: circuitOpen(id) };
    res.json({ inFlight: [...inFlight], cooldownSecondsRemaining: cooldowns, circuits, history });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

  // Malformed JSON from a misconfigured sender -> 400, never an HTML stack trace
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    log(status >= 500 ? 'error' : 'warn', 'request rejected', { path: req.path, error: err.message });
    res.status(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

  const idle = () => Promise.all([...running]);

  return { app, idle, state: { cooldownMap, inFlight, failures, history } };
}

module.exports = { createApp, extractMachineId, MACHINE_ID_PATTERN };
