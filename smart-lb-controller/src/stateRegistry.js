'use strict';

const MACHINE_IDS = ['machine-1', 'machine-2', 'machine-3', 'machine-4', 'machine-5'];
const VALID_STATUSES = new Set(['ONLINE', 'REBOOTING']);
const DEFAULT_ETA_SECONDS = 30;
const MAX_ETA_SECONDS = 3600;
const DEFAULT_REASON = 'Automated self-healing restart';

/**
 * In-memory node state table. `now` is injectable so ETA math can be tested with a fixed clock.
 */
function createRegistry({ now = Date.now } = {}) {
  function freshState(machineId) {
    return {
      machineId,
      status: 'ONLINE',
      reason: null,
      etaSeconds: null,
      etaTimestamp: null,
      rebootStartedAt: null,
      exclusiveServices: machineId === 'machine-1' ? ['gpu-render'] : [],
      updatedAt: now(),
    };
  }

  const registry = new Map(MACHINE_IDS.map((id) => [id, freshState(id)]));

  /**
   * Apply a Contract C payload. Returns { ok, state } or { ok: false, error }.
   */
  function update(payload) {
    const { machineId, status, reason, etaSeconds, exclusiveServices } =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

    if (typeof machineId !== 'string' || !registry.has(machineId)) {
      return { ok: false, error: `Unknown machineId ${typeof machineId === 'string' ? `"${machineId}"` : `(${typeof machineId})`}` };
    }
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, error: `status must be one of ${[...VALID_STATUSES].join(', ')}` };
    }

    const current = registry.get(machineId);
    const ts = now();

    if (status === 'REBOOTING') {
      // A REBOOTING notice must never be rejected (traffic would not be gated), so bad ETAs fall back to the default
      const n = Number(etaSeconds);
      const eta = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ETA_SECONDS) : DEFAULT_ETA_SECONDS;
      current.status = 'REBOOTING';
      current.reason = typeof reason === 'string' && reason.trim() ? reason : DEFAULT_REASON;
      current.etaSeconds = eta;
      current.rebootStartedAt = ts;
      current.etaTimestamp = ts + eta * 1000;
      if (Array.isArray(exclusiveServices)) current.exclusiveServices = exclusiveServices.filter((s) => typeof s === 'string');
    } else {
      current.status = 'ONLINE';
      current.reason = null;
      current.etaSeconds = null;
      current.etaTimestamp = null;
      current.rebootStartedAt = null;
    }
    current.updatedAt = ts;

    return { ok: true, state: view(current) };
  }

  function remainingSeconds(state) {
    if (state.status !== 'REBOOTING' || !state.etaTimestamp) return 0;
    return Math.max(1, Math.ceil((state.etaTimestamp - now()) / 1000));
  }

  function view(state) {
    return { ...state, exclusiveServices: [...state.exclusiveServices], remainingSeconds: remainingSeconds(state) };
  }

  function get(machineId) {
    const s = registry.get(machineId);
    return s ? view(s) : null;
  }

  function snapshot() {
    const machines = {};
    for (const [id, s] of registry) machines[id] = view(s);
    return { timestamp: new Date(now()).toISOString(), machines };
  }

  return { update, get, snapshot };
}

module.exports = { MACHINE_IDS, DEFAULT_ETA_SECONDS, MAX_ETA_SECONDS, createRegistry };
