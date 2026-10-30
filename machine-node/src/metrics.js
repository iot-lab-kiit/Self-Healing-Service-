'use strict';

const client = require('prom-client');
const si = require('systeminformation');

const MACHINE_ID = process.env.MACHINE_ID || 'machine-1';
const MEM_LIMIT_MB = parseFloat(process.env.CONTAINER_MEM_LIMIT_MB) || 256;
const MEM_LIMIT_BYTES = MEM_LIMIT_MB * 1024 * 1024;
const SIMULATE_GPU = String(process.env.SIMULATE_GPU === undefined ? 'true' : process.env.SIMULATE_GPU).toLowerCase() === 'true';

// /fault/memory plateaus the process at this share of the container limit (88%-90% band).
const MEM_TARGET_RATIO = 0.89;

// Mutable runtime state shared with index.js and faultRoutes.js
const faults = { memory: false, cpu: false, gpu: false, containerLoop: false };
const state = { memoryPlateaued: false, activeConnections: 0, draining: false };

const register = new client.Registry();
client.collectDefaultMetrics({ register, labels: { machine_id: MACHINE_ID } });

const round = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Smooth deterministic wobble so Grafana graphs look alive without ever leaving the fault band
const wobble = (amp, periodMs) => Math.sin(Date.now() / periodMs) * amp;

// ---------------------------------------------------------------- RAM
// RSS reader is an overridable property so tests can simulate memory growth deterministically
const mem = { rss: () => process.memoryUsage().rss };

function ramPercent() {
  const real = (mem.rss() / MEM_LIMIT_BYTES) * 100;
  if (faults.memory && state.memoryPlateaued) {
    return clamp(Math.max(real, 89.5), 89, 90);
  }
  if (faults.containerLoop) {
    return Math.max(real, 88.5 + wobble(0.3, 4000));
  }
  return real;
}

// ---------------------------------------------------------------- CPU
// Per-container CPU: process CPU time over wall-clock time, normalised to one core.
// (systeminformation.currentLoad() reports HOST-wide load, which would trigger false alerts
// on a busy dev laptop, so it is exported separately as an informational gauge.)
let lastCpu = process.cpuUsage();
let lastHr = process.hrtime.bigint();
let cpuPct = 1;
function sampleCpu() {
  const nowHr = process.hrtime.bigint();
  const cu = process.cpuUsage();
  const wallUs = Number(nowHr - lastHr) / 1000;
  const usedUs = cu.user - lastCpu.user + (cu.system - lastCpu.system);
  if (wallUs > 0) cpuPct = clamp((usedUs / wallUs) * 100, 0, 100);
  lastCpu = cu;
  lastHr = nowHr;
}

function cpuPercent() {
  if (faults.cpu) return 91.2 + wobble(1.2, 3000);
  return cpuPct;
}

// ---------------------------------------------------------------- GPU
let gpuSimulated = 10;
let gpuPhysical = null;
async function sampleGpu() {
  if (!SIMULATE_GPU) {
    try {
      const g = await si.graphics();
      const ctrl = (g.controllers || []).find((c) => typeof c.utilizationGpu === 'number');
      if (ctrl) {
        gpuPhysical = ctrl.utilizationGpu;
        return;
      }
    } catch (_) {
      /* no physical GPU readable - fall through to simulation */
    }
  }
  gpuPhysical = null;
  gpuSimulated = clamp(gpuSimulated + (Math.random() - 0.5) * 2, 8, 15);
}

function gpuPercent() {
  if (faults.gpu) return 93.0 + wobble(0.5, 2500);
  return gpuPhysical !== null ? gpuPhysical : gpuSimulated;
}

// ---------------------------------------------------------------- Host load (informational)
let hostCpu = 0;
async function sampleHost() {
  try {
    const l = await si.currentLoad();
    hostCpu = l.currentLoad || 0;
  } catch (_) {
    hostCpu = 0;
  }
}

// ---------------------------------------------------------------- Contract A metrics
new client.Gauge({
  name: 'node_ram_usage_percent',
  help: 'Percentage of container RAM limit currently used',
  labelNames: ['machine_id'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID }, round(ramPercent()));
  },
});

new client.Gauge({
  name: 'node_cpu_load_percent',
  help: 'Percentage of CPU load utilized',
  labelNames: ['machine_id'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID }, round(cpuPercent()));
  },
});

new client.Gauge({
  name: 'node_gpu_utilization_percent',
  help: 'Percentage of physical or simulated GPU utilized',
  labelNames: ['machine_id'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID }, round(gpuPercent()));
  },
});

const restartCounter = new client.Counter({
  name: 'node_container_restart_count',
  help: 'Counter of rapid rogue container spin-ups',
  labelNames: ['machine_id'],
  registers: [register],
});
// inc by 0 exports a 0 sample immediately (labels() alone does not create a series)
restartCounter.inc({ machine_id: MACHINE_ID }, 0);

new client.Gauge({
  name: 'node_active_connections',
  help: 'Current active HTTP client connections',
  labelNames: ['machine_id'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID }, state.activeConnections);
  },
});

new client.Gauge({
  name: 'node_host_cpu_load_percent',
  help: 'Host-wide CPU load reported by systeminformation (informational, not alerted on)',
  labelNames: ['machine_id'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID }, round(hostCpu));
  },
});

new client.Gauge({
  name: 'node_fault_active',
  help: '1 while the named fault injection is active on this node',
  labelNames: ['machine_id', 'fault'],
  registers: [register],
  collect() {
    this.set({ machine_id: MACHINE_ID, fault: 'memory' }, faults.memory ? 1 : 0);
    this.set({ machine_id: MACHINE_ID, fault: 'cpu' }, faults.cpu ? 1 : 0);
    this.set({ machine_id: MACHINE_ID, fault: 'gpu' }, faults.gpu ? 1 : 0);
    this.set({ machine_id: MACHINE_ID, fault: 'container_loop' }, faults.containerLoop ? 1 : 0);
  },
});

function resetCpuBaseline() {
  lastCpu = process.cpuUsage();
  lastHr = process.hrtime.bigint();
}

function startSamplers() {
  // Start the CPU window now: sampling from module load would count startup work (require + express
  // init) over a tiny wall-clock window and report ~100% right after every restart.
  resetCpuBaseline();
  sampleGpu();
  sampleHost();
  setInterval(sampleCpu, 2000).unref();
  setInterval(sampleGpu, 5000).unref();
  setInterval(sampleHost, 5000).unref();
}

module.exports = {
  MACHINE_ID,
  MEM_LIMIT_MB,
  MEM_LIMIT_BYTES,
  MEM_TARGET_RATIO,
  SIMULATE_GPU,
  register,
  faults,
  state,
  mem,
  restartCounter,
  ramPercent,
  cpuPercent,
  gpuPercent,
  startSamplers,
};
