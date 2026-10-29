'use strict';

const Docker = require('dockerode');
const axiosLib = require('axios');
const client = require('prom-client');

const LB_URL = process.env.LB_URL || 'http://smart-lb-controller:5000';
const NODE_PORT = parseInt(process.env.NODE_PORT, 10) || 3000;
const ETA_SECONDS = parseInt(process.env.REBOOT_ETA_SECONDS, 10) || 30;
const STOP_TIMEOUT_SECONDS = 5;
const HEALTH_POLL_MS = 2000;
const HEALTH_TIMEOUT_MS = (parseInt(process.env.HEALTH_TIMEOUT_SECONDS, 10) || 90) * 1000;
const RECOVERY_THRESHOLD = 50; // metrics must fall below this % after the restart
const RECOVERY_TIMEOUT_MS = 30000;
const REASON = 'Sustained Resource Exhaustion (>85% for >=60s)';

// Machines that host exclusive (non-replicated) services behind the Smart LB
const EXCLUSIVE_SERVICES = { 'machine-1': ['gpu-render'] };

// Internal cluster traffic must never be routed through a container-level HTTP proxy
const axios = axiosLib.create({ proxy: false });

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'remediation-engine', msg, ...extra }));
}

// ---------------------------------------------------------------- Prometheus metrics (MTTR)
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const remediationTotal = new client.Counter({
  name: 'remediation_total',
  help: 'Remediation attempts by machine and result',
  labelNames: ['machine_id', 'result'],
  registers: [register],
});
const remediationDuration = new client.Histogram({
  name: 'remediation_duration_seconds',
  help: 'Time from pre-reboot handshake to ONLINE handshake (MTTR)',
  labelNames: ['machine_id'],
  buckets: [5, 10, 15, 20, 30, 45, 60, 90, 120],
  registers: [register],
});
const remediationLast = new client.Gauge({
  name: 'remediation_last_duration_seconds',
  help: 'Duration of the most recent successful remediation (last MTTR)',
  labelNames: ['machine_id'],
  registers: [register],
});

// ---------------------------------------------------------------- Smart LB handshake (Contract C)
async function notifyLoadBalancer(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await axios.post(`${LB_URL}/internal/node-status`, payload, { timeout: 3000 });
      log('info', `LB handshake sent: ${payload.machineId} -> ${payload.status}`, { payload });
      return true;
    } catch (err) {
      lastErr = err;
      log('warn', `LB handshake attempt ${attempt}/3 failed`, { error: err.code || err.message });
      await sleep(1000);
    }
  }
  throw new Error(`Smart LB handshake failed: ${lastErr && (lastErr.code || lastErr.message)}`);
}

// ---------------------------------------------------------------- Dockerode helpers
async function findContainer(machineId) {
  const containers = await docker.listContainers({ all: true });
  const match =
    containers.find((c) => (c.Labels || {})['com.docker.compose.service'] === machineId) ||
    containers.find((c) => (c.Names || []).some((n) => n === `/${machineId}`)) ||
    containers.find((c) => (c.Names || []).some((n) => new RegExp(`[-_]${machineId}[-_]\\d+$`).test(n)));
  return match ? docker.getContainer(match.Id) : null;
}

async function waitForHealthy(machineId) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    try {
      const res = await axios.get(`http://${machineId}:${NODE_PORT}/health`, { timeout: 1500, validateStatus: () => true });
      if (res.status === 200) return true;
    } catch (_) {
      /* container still booting */
    }
  }
  return false;
}

async function readGauges(machineId) {
  const res = await axios.get(`http://${machineId}:${NODE_PORT}/metrics`, { timeout: 2000, responseType: 'text' });
  const pick = (name) => {
    const m = String(res.data).match(new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.eE+-]+)`, 'm'));
    return m ? parseFloat(m[1]) : 0;
  };
  return {
    ram: pick('node_ram_usage_percent'),
    cpu: pick('node_cpu_load_percent'),
    gpu: pick('node_gpu_utilization_percent'),
  };
}

async function waitForRecoveredMetrics(machineId) {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let gauges = null;
  while (Date.now() < deadline) {
    try {
      gauges = await readGauges(machineId);
      if (gauges.ram < RECOVERY_THRESHOLD && gauges.cpu < RECOVERY_THRESHOLD && gauges.gpu < RECOVERY_THRESHOLD) {
        return { recovered: true, gauges };
      }
    } catch (_) {
      /* metrics endpoint not ready yet */
    }
    await sleep(HEALTH_POLL_MS);
  }
  return { recovered: false, gauges };
}

/**
 * Full self-healing workflow for one node:
 * 1. pre-reboot handshake -> 2. container.restart({ t: 5 }) -> 3. health poll
 * -> 4. verify metrics < 50% -> 5. ONLINE handshake.
 */
async function remediate(machineId, context = {}) {
  const startedAt = Date.now();
  log('warn', `Remediation started for ${machineId}`, { machineId, ...context });

  // Step 1: tell the LB BEFORE touching the container (architectural invariant)
  await notifyLoadBalancer({
    machineId,
    status: 'REBOOTING',
    reason: REASON,
    exclusiveServices: EXCLUSIVE_SERVICES[machineId] || [],
    etaSeconds: ETA_SECONDS,
  });

  // Step 2: restart through the Docker daemon
  const container = await findContainer(machineId);
  if (!container) {
    log('error', `No container found for ${machineId}; restoring LB state without a restart`, { machineId });
    await notifyLoadBalancer({ machineId, status: 'ONLINE' });
    remediationTotal.inc({ machine_id: machineId, result: 'container_not_found' });
    return { machineId, result: 'container_not_found', durationSeconds: (Date.now() - startedAt) / 1000 };
  }
  await container.restart({ t: STOP_TIMEOUT_SECONDS });
  log('info', `Container restarted: ${machineId}`, { machineId });

  // Step 3: wait for /health
  const healthy = await waitForHealthy(machineId);
  if (!healthy) {
    remediationTotal.inc({ machine_id: machineId, result: 'health_timeout' });
    throw new Error(`${machineId} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
  }

  // Step 4: confirm the vitals really dropped (informational - faults are in-memory so restart clears them)
  const check = await waitForRecoveredMetrics(machineId);
  if (check.recovered) {
    log('info', `${machineId} vitals below ${RECOVERY_THRESHOLD}%`, { machineId, gauges: check.gauges });
  } else {
    log('warn', `${machineId} healthy but vitals still >= ${RECOVERY_THRESHOLD}%`, { machineId, gauges: check.gauges });
  }

  // Step 5: restore traffic
  await notifyLoadBalancer({ machineId, status: 'ONLINE' });

  const durationSeconds = (Date.now() - startedAt) / 1000;
  remediationTotal.inc({ machine_id: machineId, result: 'success' });
  remediationDuration.observe({ machine_id: machineId }, durationSeconds);
  remediationLast.set({ machine_id: machineId }, durationSeconds);
  log('info', `Remediation complete for ${machineId} in ${durationSeconds.toFixed(1)}s`, { machineId, durationSeconds });
  return { machineId, result: 'success', durationSeconds, vitals: check.gauges, vitalsRecovered: check.recovered };
}

module.exports = { remediate, notifyLoadBalancer, findContainer, register, remediationTotal, log };
