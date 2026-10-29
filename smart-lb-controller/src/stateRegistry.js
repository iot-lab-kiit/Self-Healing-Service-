'use strict';

const MACHINE_IDS = ['machine-1', 'machine-2', 'machine-3', 'machine-4', 'machine-5'];
const VALID_STATUSES = new Set(['ONLINE', 'REBOOTING']);

function freshState(machineId) {
  return {
    machineId,
    status: 'ONLINE',
    reason: null,
    etaSeconds: null,
    etaTimestamp: null,
    rebootStartedAt: null,
    exclusiveServices: machineId === 'machine-1' ? ['gpu-render'] : [],
    updatedAt: Date.now(),
  };
}

const registry = new Map(MACHINE_IDS.map((id) => [id, freshState(id)]));

/**
 * Apply a Contract C payload. Returns { ok, state } or { ok: false, error }.
 */
function update(payload) {
  const { machineId, status, reason, etaSeconds, exclusiveServices } = payload || {};

  if (!registry.has(machineId)) {
    return { ok: false, error: `Unknown machineId "${machineId}"` };
  }
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: `status must be one of ${[...VALID_STATUSES].join(', ')}` };
  }

  const current = registry.get(machineId);
  const now = Date.now();

  if (status === 'REBOOTING') {
    const eta = Number.isFinite(Number(etaSeconds)) && Number(etaSeconds) > 0 ? Number(etaSeconds) : 30;
    current.status = 'REBOOTING';
    current.reason = reason || 'Automated self-healing restart';
    current.etaSeconds = eta;
    current.rebootStartedAt = now;
    current.etaTimestamp = now + eta * 1000;
    if (Array.isArray(exclusiveServices)) current.exclusiveServices = exclusiveServices;
  } else {
    current.status = 'ONLINE';
    current.reason = null;
    current.etaSeconds = null;
    current.etaTimestamp = null;
    current.rebootStartedAt = null;
  }
  current.updatedAt = now;

  return { ok: true, state: view(current) };
}

function remainingSeconds(state) {
  if (state.status !== 'REBOOTING' || !state.etaTimestamp) return 0;
  return Math.max(1, Math.ceil((state.etaTimestamp - Date.now()) / 1000));
}

function view(state) {
  return { ...state, remainingSeconds: remainingSeconds(state) };
}

function get(machineId) {
  const s = registry.get(machineId);
  return s ? view(s) : null;
}

function snapshot() {
  const machines = {};
  for (const [id, s] of registry) machines[id] = view(s);
  return { timestamp: new Date().toISOString(), machines };
}

module.exports = { MACHINE_IDS, update, get, snapshot };
