'use strict';

const express = require('express');
const m = require('./metrics');

const router = express.Router();
const MB = 1024 * 1024;

const leak = { chunks: [], bytes: 0, timer: null };
let cpuTimer = null;
let loopTimer = null;
let loopCount = 0;

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, machineId: m.MACHINE_ID, msg, ...extra }));
}

function snapshot() {
  return {
    machineId: m.MACHINE_ID,
    faults: { ...m.faults },
    memoryPlateaued: m.state.memoryPlateaued,
    ramPercent: Math.round(m.ramPercent() * 100) / 100,
    cpuPercent: Math.round(m.cpuPercent() * 100) / 100,
    gpuPercent: Math.round(m.gpuPercent() * 100) / 100,
  };
}

// Allocate real, committed buffers in <=10MB steps every 500ms and stop at ~89% of the
// container limit, so the node stays in the 88-90% band (>85% alert threshold) for the whole
// 60s evaluation window without ever tripping the kernel OOM killer.
function startMemoryLeak() {
  if (m.faults.memory) return false;
  m.faults.memory = true;
  m.state.memoryPlateaued = false;
  log('error', `[FAULT] Memory leak injected on ${m.MACHINE_ID}`, { fault: 'memory', targetPercent: m.MEM_TARGET_RATIO * 100 });

  const target = m.MEM_LIMIT_BYTES * m.MEM_TARGET_RATIO;
  leak.timer = setInterval(() => {
    // Also bound by bytes already leaked, so allocation stays finite even if RSS lags behind
    // (lazily committed pages, buffers from a previous run not yet collected).
    const remaining = Math.min(target - m.mem.rss(), target - leak.bytes);
    if (remaining < 512 * 1024) {
      clearInterval(leak.timer);
      leak.timer = null;
      m.state.memoryPlateaued = true;
      log('warn', `[FAULT] Memory leak plateaued on ${m.MACHINE_ID}`, { fault: 'memory', chunks: leak.chunks.length });
      return;
    }
    // fill(1) forces the OS to commit the pages so RSS really grows
    const chunk = Buffer.alloc(Math.min(10 * MB, Math.floor(remaining)), 1);
    leak.chunks.push(chunk);
    leak.bytes += chunk.length;
  }, 500);
  return true;
}

// Busy-loop 90ms of every 100ms: ~90% of one core while still yielding to the event loop
function startCpuSpike() {
  if (m.faults.cpu) return false;
  m.faults.cpu = true;
  log('error', `[FAULT] CPU saturation triggered on ${m.MACHINE_ID}`, { fault: 'cpu' });
  cpuTimer = setInterval(() => {
    const end = Date.now() + 90;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(Math.random() * 1e6);
    return x;
  }, 100);
  return true;
}

function startGpuSpike() {
  if (m.faults.gpu) return false;
  m.faults.gpu = true;
  log('error', `[FAULT] GPU saturation triggered on ${m.MACHINE_ID}`, { fault: 'gpu' });
  return true;
}

function tickLoop() {
  loopCount += 1;
  m.restartCounter.inc({ machine_id: m.MACHINE_ID });
  log('error', `[FAULT] Rogue container spin-up #${loopCount} on ${m.MACHINE_ID}`, { fault: 'container-loop', spinUp: loopCount });
}

function startContainerLoop() {
  if (m.faults.containerLoop) return false;
  m.faults.containerLoop = true;
  loopCount = 0;
  log('error', `[FAULT] Rogue container loop started on ${m.MACHINE_ID}`, { fault: 'container-loop' });
  tickLoop();
  loopTimer = setInterval(tickLoop, 5000);
  return true;
}

function resetAll() {
  if (leak.timer) clearInterval(leak.timer);
  if (cpuTimer) clearInterval(cpuTimer);
  if (loopTimer) clearInterval(loopTimer);
  leak.timer = cpuTimer = loopTimer = null;
  leak.chunks.length = 0;
  leak.bytes = 0;
  m.state.memoryPlateaued = false;
  Object.keys(m.faults).forEach((k) => {
    m.faults[k] = false;
  });
  if (typeof global.gc === 'function') global.gc();
  log('info', `[FAULT] All faults reset on ${m.MACHINE_ID}`, { fault: 'reset' });
}

router.get('/status', (req, res) => res.json(snapshot()));

router.post('/memory', (req, res) => {
  const started = startMemoryLeak();
  res.status(started ? 202 : 200).json({ ok: true, fault: 'memory', started, ...snapshot() });
});

router.post('/cpu', (req, res) => {
  const started = startCpuSpike();
  res.status(started ? 202 : 200).json({ ok: true, fault: 'cpu', started, ...snapshot() });
});

router.post('/gpu', (req, res) => {
  const started = startGpuSpike();
  res.status(started ? 202 : 200).json({ ok: true, fault: 'gpu', started, ...snapshot() });
});

router.post('/container-loop', (req, res) => {
  const started = startContainerLoop();
  res.status(started ? 202 : 200).json({ ok: true, fault: 'container-loop', started, ...snapshot() });
});

router.post('/reset', (req, res) => {
  resetAll();
  res.json({ ok: true, fault: 'reset', ...snapshot() });
});

module.exports = { router, resetAll, leak };
