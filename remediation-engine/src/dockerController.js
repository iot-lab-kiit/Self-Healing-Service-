'use strict';

const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const axiosLib = require('axios');
const client = require('prom-client');

const REASON = 'Sustained Resource Exhaustion (>85% for >=60s)';
const RECOVERY_THRESHOLD = 50; // metrics must fall below this % after the restart

// Machines that host exclusive (non-replicated) services behind the Smart LB
const EXCLUSIVE_SERVICES = { 'machine-1': ['gpu-render'] };

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'remediation-engine', msg, ...extra }));
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- Prometheus metrics (MTTR)
function createMetrics(register) {
  return {
    remediationTotal: new client.Counter({
      name: 'remediation_total',
      help: 'Remediation attempts by machine and result',
      labelNames: ['machine_id', 'result'],
      registers: [register],
    }),
    remediationDuration: new client.Histogram({
      name: 'remediation_duration_seconds',
      help: 'Time from pre-reboot handshake to ONLINE handshake (MTTR)',
      labelNames: ['machine_id'],
      buckets: [5, 10, 15, 20, 30, 45, 60, 90, 120],
      registers: [register],
    }),
    remediationLast: new client.Gauge({
      name: 'remediation_last_duration_seconds',
      help: 'Duration of the most recent successful remediation (last MTTR)',
      labelNames: ['machine_id'],
      registers: [register],
    }),
    circuitOpen: new client.Gauge({
      name: 'remediation_circuit_open',
      help: '1 when automatic remediation is suspended for a machine after repeated failures',
      labelNames: ['machine_id'],
      registers: [register],
    }),
  };
}

const MACHINE_ID_PATTERN = /^machine-[1-9][0-9]*$/;

/**
 * Multi-host mode: DOCKER_HOSTS maps machine ids to the Docker daemon on that machine, e.g.
 *   {"machine-1": {"url": "tcp://10.0.0.11:2376", "certDir": "/certs/machine-1"}, "machine-2": "tcp://lab-2:2375"}
 * certDir holds ca.pem, cert.pem and key.pem for mutual TLS. Unlisted machines use the local socket.
 */
function parseDockerHosts(raw) {
  if (!raw || !String(raw).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DOCKER_HOSTS is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DOCKER_HOSTS must be a JSON object');
  const hosts = {};
  for (const [machineId, value] of Object.entries(parsed)) {
    if (!MACHINE_ID_PATTERN.test(machineId)) throw new Error(`DOCKER_HOSTS: invalid machine id "${machineId}"`);
    const spec = typeof value === 'string' ? { url: value } : value || {};
    let url;
    try {
      url = new URL(spec.url);
    } catch (_) {
      throw new Error(`DOCKER_HOSTS: ${machineId} needs a tcp://host:port url`);
    }
    if (url.protocol !== 'tcp:' || !url.hostname) throw new Error(`DOCKER_HOSTS: ${machineId} needs a tcp://host:port url`);
    const certDir = typeof spec.certDir === 'string' && spec.certDir ? spec.certDir : null;
    hosts[machineId] = { host: url.hostname, port: Number(url.port) || (certDir ? 2376 : 2375), certDir };
  }
  return hosts;
}

function remoteDockerClient(spec) {
  if (!spec.certDir) return new Docker({ host: spec.host, port: spec.port, protocol: 'http' });
  const read = (file) => fs.readFileSync(path.join(spec.certDir, file));
  return new Docker({ host: spec.host, port: spec.port, protocol: 'https', ca: read('ca.pem'), cert: read('cert.pem'), key: read('key.pem') });
}

function remediationError(result, message) {
  const err = new Error(message);
  err.result = result;
  return err;
}

/**
 * Every dependency is injectable so the workflow can be tested without Docker or a network.
 * Defaults reproduce the production (env-driven) configuration.
 */
function createRemediator(options = {}) {
  const {
    // Internal cluster traffic must never be routed through a container-level HTTP proxy
    http = axiosLib.create({ proxy: false }),
    docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' }),
    dockerHosts = parseDockerHosts(process.env.DOCKER_HOSTS),
    dockerFactory = remoteDockerClient,
    lbUrl = process.env.LB_URL || 'http://smart-lb-controller:5000',
    nodePort = envInt('NODE_PORT', 3000),
    etaSeconds = envInt('REBOOT_ETA_SECONDS', 30),
    retryEtaSeconds = envInt('RETRY_ETA_SECONDS', 60),
    stopTimeoutSeconds = 5,
    healthTimeoutMs = envInt('HEALTH_TIMEOUT_SECONDS', 90) * 1000,
    recoveryTimeoutMs = 30000,
    pollMs = 2000,
    lbRetryDelayMs = 1000,
    sleep = realSleep,
    now = Date.now,
    logger = log,
    register = new client.Registry(),
  } = options;

  const metrics = createMetrics(register);
  const remoteDocker = {};
  for (const [machineId, spec] of Object.entries(dockerHosts)) {
    remoteDocker[machineId] = dockerFactory(spec);
    if (!spec.certDir) logger('warn', `${machineId}: Docker API at ${spec.host}:${spec.port} has no TLS - use only on a trusted lab network`, { machineId });
  }
  const dockerFor = (machineId) => remoteDocker[machineId] || docker;
  const { remediationTotal, remediationDuration, remediationLast } = metrics;

  // ---------------------------------------------------------------- Smart LB handshake (Contract C)
  async function notifyLoadBalancer(payload) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await http.post(`${lbUrl}/internal/node-status`, payload, { timeout: 3000 });
        logger('info', `LB handshake sent: ${payload.machineId} -> ${payload.status}`, { payload });
        return true;
      } catch (err) {
        lastErr = err;
        logger('warn', `LB handshake attempt ${attempt}/3 failed`, { error: err.code || err.message });
        await sleep(lbRetryDelayMs);
      }
    }
    throw new Error(`Smart LB handshake failed: ${lastErr && (lastErr.code || lastErr.message)}`);
  }

  // ---------------------------------------------------------------- Dockerode helpers
  async function findContainer(machineId) {
    const daemon = dockerFor(machineId);
    const containers = await daemon.listContainers({ all: true });
    const match =
      containers.find((c) => (c.Labels || {})['com.docker.compose.service'] === machineId) ||
      containers.find((c) => (c.Names || []).some((n) => n === `/${machineId}`)) ||
      containers.find((c) => (c.Names || []).some((n) => new RegExp(`[-_]${machineId}[-_]\\d+$`).test(n)));
    return match ? daemon.getContainer(match.Id) : null;
  }

  async function waitForHealthy(machineId) {
    const deadline = now() + healthTimeoutMs;
    while (now() < deadline) {
      await sleep(pollMs);
      try {
        const res = await http.get(`http://${machineId}:${nodePort}/health`, { timeout: 1500, validateStatus: () => true });
        if (res.status === 200) return true;
      } catch (_) {
        /* container still booting */
      }
    }
    return false;
  }

  async function readGauges(machineId) {
    const res = await http.get(`http://${machineId}:${nodePort}/metrics`, { timeout: 2000, responseType: 'text' });
    // A missing line is null (unknown), never 0 - a partial scrape must not count as "recovered"
    const pick = (name) => {
      const m = String(res.data).match(new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.eE+-]+)`, 'm'));
      return m ? parseFloat(m[1]) : null;
    };
    return {
      ram: pick('node_ram_usage_percent'),
      cpu: pick('node_cpu_load_percent'),
      gpu: pick('node_gpu_utilization_percent'),
    };
  }

  const isRecovered = (g) => Object.values(g).every((v) => v !== null && v < RECOVERY_THRESHOLD);

  async function waitForRecoveredMetrics(machineId) {
    const deadline = now() + recoveryTimeoutMs;
    let gauges = null;
    while (now() < deadline) {
      try {
        gauges = await readGauges(machineId);
        if (isRecovered(gauges)) return { recovered: true, gauges };
      } catch (_) {
        /* metrics endpoint not ready yet */
      }
      await sleep(pollMs);
    }
    return { recovered: false, gauges };
  }

  /**
   * Full self-healing workflow for one node:
   * 1. pre-reboot handshake -> 2. container.restart({ t: 5 }) -> 3. health poll
   * -> 4. verify metrics < 50% -> 5. ONLINE handshake.
   * Resolves with { result: 'success' | 'container_not_found', ... }; rejects with err.result set on failure.
   */
  async function remediate(machineId, context = {}) {
    const startedAt = now();
    const exclusiveServices = EXCLUSIVE_SERVICES[machineId] || [];
    logger('warn', `Remediation started for ${machineId}`, { machineId, ...context });

    // Step 1: tell the LB BEFORE touching the container (architectural invariant).
    // An unreachable LB must not stop the node from healing - nodes 2-5 don't depend on it.
    let lbSynced = true;
    try {
      await notifyLoadBalancer({ machineId, status: 'REBOOTING', reason: REASON, exclusiveServices, etaSeconds });
    } catch (err) {
      lbSynced = false;
      remediationTotal.inc({ machine_id: machineId, result: 'lb_unreachable' });
      logger('error', `Smart LB unreachable; restarting ${machineId} anyway`, { machineId, error: err.message });
    }

    try {
      // Step 2: restart through the Docker daemon
      const container = await findContainer(machineId);
      if (!container) {
        logger('error', `No container found for ${machineId}; restoring LB state without a restart`, { machineId });
        await notifyLoadBalancer({ machineId, status: 'ONLINE' }).catch(() => {});
        remediationTotal.inc({ machine_id: machineId, result: 'container_not_found' });
        return { machineId, result: 'container_not_found', durationSeconds: (now() - startedAt) / 1000 };
      }
      try {
        await container.restart({ t: stopTimeoutSeconds });
      } catch (err) {
        throw remediationError('restart_failed', `docker restart of ${machineId} failed: ${err.message}`);
      }
      logger('info', `Container restarted: ${machineId}`, { machineId });

      // Step 3: wait for /health
      if (!(await waitForHealthy(machineId))) {
        throw remediationError('health_timeout', `${machineId} did not become healthy within ${healthTimeoutMs / 1000}s`);
      }
    } catch (err) {
      // Keep the LB on REBOOTING (countdown / 503) rather than routing users to a dead node,
      // with a fresh ETA so the countdown doesn't sit at 1s while Alertmanager's repeat retries.
      const result = err.result || 'failed';
      remediationTotal.inc({ machine_id: machineId, result });
      await notifyLoadBalancer({
        machineId,
        status: 'REBOOTING',
        reason: `Remediation failed: ${err.message} - retrying`,
        exclusiveServices,
        etaSeconds: retryEtaSeconds,
      }).catch((lbErr) => logger('error', 'could not refresh LB after failed remediation', { machineId, error: lbErr.message }));
      err.result = result;
      throw err;
    }

    // Step 4: confirm the vitals really dropped (informational - faults are in-memory so restart clears them)
    const check = await waitForRecoveredMetrics(machineId);
    if (check.recovered) {
      logger('info', `${machineId} vitals below ${RECOVERY_THRESHOLD}%`, { machineId, gauges: check.gauges });
    } else {
      logger('warn', `${machineId} healthy but vitals not confirmed below ${RECOVERY_THRESHOLD}%`, { machineId, gauges: check.gauges });
    }

    // Step 5: restore traffic. The node is healed either way, so a failed ONLINE is logged, not fatal.
    try {
      await notifyLoadBalancer({ machineId, status: 'ONLINE' });
      lbSynced = true;
    } catch (err) {
      lbSynced = false;
      logger('error', `${machineId} healed but the ONLINE handshake failed`, { machineId, error: err.message });
    }

    const durationSeconds = (now() - startedAt) / 1000;
    remediationTotal.inc({ machine_id: machineId, result: 'success' });
    remediationDuration.observe({ machine_id: machineId }, durationSeconds);
    remediationLast.set({ machine_id: machineId }, durationSeconds);
    logger('info', `Remediation complete for ${machineId} in ${durationSeconds.toFixed(1)}s`, { machineId, durationSeconds });
    return { machineId, result: 'success', durationSeconds, vitals: check.gauges, vitalsRecovered: check.recovered, lbSynced };
  }

  return { remediate, notifyLoadBalancer, findContainer, readGauges, register, metrics, log: logger };
}

module.exports = { createRemediator, parseDockerHosts, log, REASON, EXCLUSIVE_SERVICES, RECOVERY_THRESHOLD };
