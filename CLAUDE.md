# Project Context: Distributed Self-Healing Cluster

## Core Commands
- Boot full cluster: `docker compose up -d --build`
- Tear down cluster: `docker compose down -v`
- View Remediation logs: `docker compose logs -f remediation-engine`
- Test shared service: `curl http://localhost:8080/api/shared`
- Test exclusive GPU service: `curl http://localhost:8080/api/gpu-render`
- Trigger memory fault on Node 1: `curl -X POST http://localhost:3001/fault/memory`
- Trigger GPU fault on Node 1: `curl -X POST http://localhost:3001/fault/gpu`
- Trigger CPU fault on Node 1: `curl -X POST http://localhost:3001/fault/cpu`
- Trigger rogue container loop on Node 1: `curl -X POST http://localhost:3001/fault/container-loop`
- Reset all faults on Node 1: `curl -X POST http://localhost:3001/fault/reset`
- View Smart LB logs: `docker compose logs -f smart-lb-controller`

## Git Conventions
- Never add Claude attribution to commits or PRs: no `Co-Authored-By: Claude ...`, no `Claude-Session: ...`, no "Generated with Claude Code" footer.

## Architectural Invariants (DO NOT VIOLATE)
1. **Metrics Keys:** Always expose `node_ram_usage_percent`, `node_cpu_load_percent`, `node_gpu_utilization_percent`, `node_container_restart_count`, and `node_active_connections` on `GET /metrics` (label `machine_id`).
2. **Alert Thresholds:** Prometheus must scrape every `5s` and evaluate sustained resource anomalies at `> 85%` for `for: 60s`.
3. **Controlled Memory Leak:** `POST /fault/memory` must plateau memory allocation around `88%-90%` of the container limit (`256M`) so the container is not prematurely OOM-killed by the host kernel before the 60s Prometheus alert fires.
4. **GPU Fallback:** Always support `SIMULATE_GPU=true` in `machine-node` so machines without dedicated Nvidia GPUs can simulate >85% GPU load.
5. **Pre-Reboot Handshake:** `remediation-engine` must notify `smart-lb-controller` (`POST /internal/node-status` with `status: "REBOOTING"`, `etaSeconds: 30`) BEFORE calling `dockerode` `container.restart()`.
