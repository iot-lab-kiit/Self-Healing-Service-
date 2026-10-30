# Project Context & Master Blueprint: Distributed Self-Healing Cluster

This `CONTEXT.md` file serves as the single source of truth for **Claude Code** (or any AI coding agent) and the **4-person engineering team** building the **Distributed Self-Healing Cluster & Smart Load-Balancing System**.

---

## 1. Quick Commands & Operational Reference (For `CLAUDE.md` / Terminal)

- **Boot Full Cluster:** `docker compose up -d --build`
- **Tear Down Cluster:** `docker compose down -v`
- **Tail Remediation Engine Logs:** `docker compose logs -f remediation-engine`
- **Tail Smart LB Logs:** `docker compose logs -f smart-lb-controller`
- **Test Replicated Shared Service (Traefik):** `curl http://localhost:8080/api/shared`
- **Test Exclusive GPU Service (Smart LB):** `curl http://localhost:8080/api/gpu-render`
- **Inject Memory Leak (>85% RAM on `machine-1`):** `curl -X POST http://localhost:3001/fault/memory`
- **Inject CPU Spike (>85% CPU on `machine-1`):** `curl -X POST http://localhost:3001/fault/cpu`
- **Inject GPU Saturation (>85% GPU on `machine-1`):** `curl -X POST http://localhost:3001/fault/gpu`
- **Inject Rogue Container Loop (`machine-1`):** `curl -X POST http://localhost:3001/fault/container-loop`
- **Reset All Faults (`machine-1`):** `curl -X POST http://localhost:3001/fault/reset`

---

## 2. Architectural Invariants (DO NOT VIOLATE)

1. **Exact Prometheus Metric Keys:** Every machine node (`machine-1` to `machine-5`) MUST expose default `prom-client` process metrics (`process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `process_cpu_seconds_total`) PLUS these exact custom Gauge/Counter metrics on `GET /metrics` with label `{machine_id="machine-X"}`:
   - `node_ram_usage_percent`
   - `node_cpu_load_percent`
   - `node_gpu_utilization_percent`
   - `node_container_restart_count`
   - `node_active_connections`
2. **Strict Scrape & Alerting Threshold:** Prometheus MUST scrape all targets every `5s` (`scrape_interval: 5s`, `evaluation_interval: 5s`) and evaluate sustained resource anomalies at **`> 85%` continuously for `>= 60 seconds` (`for: 60s`)** before Alertmanager dispatches an HTTP POST webhook.
3. **Controlled Memory Leak Ceiling:** `POST /fault/memory` MUST cap memory buffer allocation around **`88%–90%`** of the container's `256M` limit so that the container remains above `85%` for the full 60-second Prometheus evaluation window without triggering an immediate host kernel OOM-kill.
4. **Hardware-Agnostic GPU Simulation:** Always support `SIMULATE_GPU=true` inside `machine-node` so developer laptops without dedicated Nvidia GPUs can reliably report and spike `node_gpu_utilization_percent` past `85%`.
5. **Pre-Reboot Load Balancer Handshake:** Before restarting any container via `dockerode`, `remediation-engine` MUST send an HTTP POST to `smart-lb-controller` (`POST /internal/node-status`) marking the node as `REBOOTING` with `etaSeconds: 30`.
6. **Dual-Mode Traffic Handling During Reboot:**
   - **Shared Service (`/api/shared` on Machines 1–5):** Traefik automatically routes around the rebooting node to healthy nodes (`machine-2..5`) with zero dropped requests.
   - **Exclusive Service (`/api/gpu-render` ONLY on `machine-1`):** `smart-lb-controller` intercepts requests while `machine-1` is `REBOOTING` and serves a live auto-refreshing HTML countdown screen (`waitingScreen.html`) to browsers (or `503` JSON with `Retry-After` to API clients).

---

## 3. Complete Tech Stack & Component Roles

| Technology | Where It Runs | Role in the Self-Healing Pipeline |
| :--- | :--- | :--- |
| **Node.js (Express)** | `machine-1..5`, `remediation-engine`, `smart-lb-controller` | Runs the target REST APIs, telemetry agent, deterministic fault routes, webhook remediation listener, and Smart LB state registry. |
| **Traefik (v3.0)** | Edge Reverse Proxy (`:8080`, Dashboard `:8081`) | Watches `/var/run/docker.sock` to auto-discover `machine-1..5`, run 2-second `/health` checks, load-balance `/api/shared`, and forward `/api/gpu-render` to `smart-lb-controller`. |
| **cAdvisor** | Host Container Monitor (`:8082`) | Reads kernel cgroup RAM/CPU stats directly from the Docker daemon so Prometheus still detects spikes even if a Node.js event loop freezes completely. |
| **`prom-client` & `systeminformation`** | `machine-1..5` (`/metrics`) | Exposes process heap, RSS, CPU load, container restart counters, and physical/simulated GPU utilization (`node_gpu_utilization_percent`). |
| **Prometheus** | Observability Plane (`:9090`) | Scrapes all 5 machines and cAdvisor every `5s` and evaluates sustained `> 85%` for `>= 60s` alert rules. |
| **Alertmanager** | Observability Plane (`:9093`) | Receives firing alerts from Prometheus and dispatches HTTP POST JSON webhooks to `http://remediation-engine:4000/webhook`. |
| **Dockerode** | `remediation-engine` (`:4000`) | Connects to `/var/run/docker.sock` to programmatically restart unhealthy containers (`container.restart({ t: 5 })`) and stop runaway container loops. |
| **Grafana Loki & Promtail** | Observability Plane (`:3100`) | Streams and indexes stdout/stderr logs from all containers in real time so forensic crash logs survive container restarts. |
| **Grafana** | Observability Plane (`:3000`) | Displays live cluster status panels, RAM/CPU/GPU time-series graphs with `85%` threshold lines, MTTR metrics, and live Loki log streams. |

---

## 4. Target Workspace Directory Structure

```text
self-healing-cluster/
├── CLAUDE.md
├── CONTEXT.md
├── implementation_plan.md
├── docker-compose.yml
├── .env.example
├── README.md
├── machine-node/                  # Person 1: Deployed as 5 instances (machine-1 to machine-5)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # Express app (/health, /api/shared, /api/gpu-render)
│       ├── metrics.js             # prom-client + systeminformation (RAM, CPU, GPU + SIMULATE_GPU)
│       └── faultRoutes.js         # Deterministic faults (/fault/memory, /cpu, /gpu, /container-loop, /reset)
├── remediation-engine/            # Person 2: Dockerode-powered self-healing engine
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # POST /webhook listener + 45s per-node cooldown guard
│       └── dockerController.js    # Pre-reboot LB handshake + Dockerode container restart + health poll
├── smart-lb-controller/           # Person 3: Traffic Gatekeeper & Live Waiting UI
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # Express server (/internal/node-status, /cluster-status, /api/gpu-render)
│       ├── stateRegistry.js       # In-memory state table (ONLINE vs REBOOTING + ETA timestamp)
│       └── views/
│           └── waitingScreen.html # Live JS countdown UI for rebooting exclusive services
└── observability/                 # Person 4: Monitoring, Alerting, Logs & Dashboards
    ├── prometheus/
    │   ├── prometheus.yml         # 5s scrape config for machine-1..5 & cAdvisor
    │   └── alert_rules.yml        # >85% RAM, CPU, GPU for >=60s rules
    ├── alertmanager/
    │   └── alertmanager.yml       # Dispatches HTTP POST webhooks to remediation-engine:4000/webhook
    ├── loki/
    │   ├── loki-config.yml
    │   └── promtail-config.yml    # Tails Docker container logs into Loki
    └── grafana/
        └── provisioning/
            ├── datasources/
            │   └── datasources.yml # Auto-provisions Prometheus & Loki
            └── dashboards/
                ├── dashboards.yml
                └── cluster_overview.json
```

---

## 5. 4-Person Team Division & Branching Strategy

| Role & Branch | Directory Ownership | Core Deliverables |
| :--- | :--- | :--- |
| **Person 1:** Target Node & Chaos Engineer<br>Branch: `feat/machine-node` | `/machine-node/` | Express app (`/health`, `/api/shared`, `/api/gpu-render`), `/metrics` exporter (`prom-client` + `systeminformation` + `SIMULATE_GPU`), and deterministic fault injection routes (`/fault/memory`, `/cpu`, `/gpu`, `/container-loop`, `/reset`). |
| **Person 2:** Orchestration & Remediation Engineer<br>Branch: `feat/remediation-engine` | `/remediation-engine/` & `docker-compose.yml` | Alertmanager webhook receiver (`POST /webhook`), 45-second per-node cooldown map, pre-reboot handshake caller, `dockerode` container restart controller, and post-recovery health verifier. |
| **Person 3:** Smart LB, Traefik & UI Lead<br>Branch: `feat/smart-lb` | `/smart-lb-controller/` | Traefik routing labels, Cluster State Registry (`POST /internal/node-status`, `GET /cluster-status`), `/api/gpu-render` proxy/interceptor, and live auto-refreshing `waitingScreen.html` countdown UI. |
| **Person 4:** Observability, Loki & Grafana Lead<br>Branch: `feat/observability-stack` | `/observability/` | `prometheus.yml` (5s scrape), `alert_rules.yml` (>85% for >=60s), `alertmanager.yml`, `loki-config.yml`, `promtail-config.yml`, and Grafana auto-provisioned datasources + `cluster_overview.json` dashboard. |

---

## 6. Frozen Port Map & API Contracts

### 6.1 Port Allocations
- `8080`: Traefik Public HTTP Entrypoint (`http://localhost:8080/api/shared`, `/api/gpu-render`, `/cluster-status`)
- `8081`: Traefik Internal Dashboard
- `5000`: Smart LB Controller (`POST /internal/node-status`, `GET /cluster-status`, `GET /api/gpu-render`)
- `4000`: Remediation Engine (`POST /webhook`)
- `3001`–`3005`: Host ports mapped to `machine-1` through `machine-5` (internal container port `3000`)
- `8082`: cAdvisor Host Port (internal port `8080`)
- `9090`: Prometheus Server
- `9093`: Alertmanager
- `3100`: Grafana Loki
- `3000`: Grafana UI (`http://localhost:3000`)

### 6.2 Contract A: Telemetry Metrics (`GET /metrics` on `machine-1..5:3000`)
```text
# HELP node_ram_usage_percent Percentage of container RAM limit currently used
# TYPE node_ram_usage_percent gauge
node_ram_usage_percent{machine_id="machine-1"} 34.2

# HELP node_cpu_load_percent Percentage of CPU load utilized
# TYPE node_cpu_load_percent gauge
node_cpu_load_percent{machine_id="machine-1"} 12.5

# HELP node_gpu_utilization_percent Percentage of physical or simulated GPU utilized
# TYPE node_gpu_utilization_percent gauge
node_gpu_utilization_percent{machine_id="machine-1"} 10.0

# HELP node_container_restart_count Counter of rapid rogue container spin-ups
# TYPE node_container_restart_count counter
node_container_restart_count{machine_id="machine-1"} 0

# HELP node_active_connections Current active HTTP client connections
# TYPE node_active_connections gauge
node_active_connections{machine_id="machine-1"} 4
```

### 6.3 Contract B: Alertmanager Webhook Payload (`POST http://remediation-engine:4000/webhook`)
```json
{
  "version": "4",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "SustainedHighRAM",
        "machine_id": "machine-1",
        "instance": "machine-1:3000",
        "severity": "critical"
      },
      "annotations": {
        "summary": "High RAM utilization on machine-1 (>85% for >=60s)"
      }
    }
  ]
}
```

### 6.4 Contract C: Pre-Reboot & Post-Recovery Handshake (`POST http://smart-lb-controller:5000/internal/node-status`)
**Pre-Reboot Payload:**
```json
{
  "machineId": "machine-1",
  "status": "REBOOTING",
  "reason": "Sustained Resource Exhaustion (>85% for >=60s)",
  "exclusiveServices": ["gpu-render"],
  "etaSeconds": 30
}
```
**Post-Recovery Payload:**
```json
{
  "machineId": "machine-1",
  "status": "ONLINE"
}
```

---

## 7. Detailed Module Specifications

### Phase 1: Machine Node (`./machine-node`)
- **Dependencies:** `express`, `prom-client`, `systeminformation`, `cors`.
- **Environment Variables:** `MACHINE_ID` (`machine-1`..`machine-5`), `PORT=3000`, `CONTAINER_MEM_LIMIT_MB=256`, `SIMULATE_GPU=true`, `EXCLUSIVE_SERVICE=true` (`true` on `machine-1`, `false` on `machine-2..5`).
- **Routes:**
  - `GET /health`: Returns `200 OK` `{ status: "healthy", machineId, uptime }` normally, or `503` if draining.
  - `GET /api/shared`: Returns `200 OK` `{ machineId, service: "shared-api", status: "ok", timestamp }`.
  - `GET /api/gpu-render`: Returns `200 OK` `{ machineId, service: "gpu-renderer", status: "Rendered Frame", timestamp }`.
  - `POST /fault/memory`: Allocates uncollected Buffers up to ~88% of `256MB` and sets `node_ram_usage_percent` to `89.5%`. Logs structured JSON `[FAULT] Memory leak injected on ${MACHINE_ID}` to `stdout` so Promtail/Loki captures it.
  - `POST /fault/cpu`: Runs an interval compute loop and sets `node_cpu_load_percent` to `91.2%`.
  - `POST /fault/gpu`: Sets `node_gpu_utilization_percent` to `93.0%` and logs `[FAULT] GPU saturation triggered on ${MACHINE_ID}`.
  - `POST /fault/container-loop`: Increments `node_container_restart_count` every 5s and spikes RAM to `88.5%`.
  - `POST /fault/reset`: Clears all allocated buffers and resets metrics to normal baseline (`~22%` RAM, `~12%` CPU, `10%` GPU).

### Phase 2: Dockerode Remediation Engine (`./remediation-engine`)
- **Dependencies:** `express`, `dockerode`, `axios`.
- **Volume Mount:** `/var/run/docker.sock:/var/run/docker.sock`.
- **Workflow (`POST /webhook`):**
  1. Filter `req.body.alerts` for `status === "firing"`.
  2. Extract `machineId = alert.labels.machine_id || alert.labels.instance.split(':')[0]`.
  3. Check 45-second cooldown map (`cooldownMap.get(machineId)`). If active, skip duplicate trigger.
  4. Send Pre-Reboot Handshake (`status: "REBOOTING"`, `etaSeconds: 30`) to `http://smart-lb-controller:5000/internal/node-status`.
  5. Locate container matching `machineId` via `dockerode` (`docker.listContainers({ all: true })` matching name or `com.docker.compose.service === machineId`) and execute `await container.restart({ t: 5 })`.
  6. Poll `http://${machineId}:3000/health` every 2 seconds until it returns `200 OK`, then send `status: "ONLINE"` to `http://smart-lb-controller:5000/internal/node-status`.

### Phase 3: Smart LB Controller & Waiting Screen (`./smart-lb-controller`)
- **Dependencies:** `express`, `axios`, `cors`.
- **State Registry (`src/stateRegistry.js`):** Tracks `machine-1`..`machine-5` status (`ONLINE` vs `REBOOTING`), `reason`, `etaTimestamp`, and `exclusiveServices`.
- **Routes:**
  - `POST /internal/node-status`: Updates node status and calculates `etaTimestamp = Date.now() + (etaSeconds * 1000)`.
  - `GET /cluster-status`: Returns JSON snapshot of all 5 nodes.
  - `GET /api/gpu-render`:
    - If `machine-1` is `ONLINE`, proxies request to `http://machine-1:3000/api/gpu-render` and returns `200 OK`.
    - If `machine-1` is `REBOOTING`, calculates `remainingSeconds = Math.max(1, Math.ceil((etaTimestamp - Date.now()) / 1000))` and responds with HTTP `503` + `Retry-After: ${remainingSeconds}`.
    - For browsers (`Accept: text/html`), serves `waitingScreen.html` featuring a modern dark-mode status card, live progress bar, 1-second JS countdown timer, and a 2-second `/cluster-status` poller that automatically reloads the page as soon as `machine-1` is `ONLINE`.
    - For API clients (`Accept: application/json`), returns `{ error: "Service Temporarily Rebooting", machineId: "machine-1", reason, retryAfterSeconds: remainingSeconds }`.

### Phase 4: Observability & Docker Compose (`./observability` & `docker-compose.yml`)
- **Prometheus (`prometheus.yml` & `alert_rules.yml`):** `5s` scrape/evaluation interval across `machine-1:3000`..`machine-5:3000` and `cadvisor:8080`. Alert rules `SustainedHighRAM`, `SustainedHighCPU`, and `SustainedHighGPU` evaluate `> 85` for `for: 60s`.
- **Alertmanager (`alertmanager.yml`):** Routes firing alerts (`group_wait: 2s`, `group_interval: 5s`) to `http://remediation-engine:4000/webhook`.
- **Loki & Promtail:** Promtail tails `/var/lib/docker/containers/*/*.log` and ships container logs to `http://loki:3100/loki/api/v1/push`.
- **Grafana:** Auto-provisions Prometheus and Loki datasources plus `cluster_overview.json` dashboard.

---

## 8. Master Prompt to Paste into Claude Code

Copy and paste the prompt below directly into Claude Code in your terminal:

```text
Read CONTEXT.md and implementation_plan.md in the root of this repository. 

Act as a Staff Infrastructure & Full-Stack Systems Engineer. Autonomously scaffold and implement the entire Distributed Self-Healing Cluster project across all directories (`machine-node`, `remediation-engine`, `smart-lb-controller`, `observability`, and `docker-compose.yml`).

Strict Requirements:
1. Write 100% complete, runnable code for every file listed in Section 4 of CONTEXT.md. Do not leave any placeholders, stub functions, or TODOs.
2. Follow all Port Allocations, Metric Keys (`node_ram_usage_percent`, `node_cpu_load_percent`, `node_gpu_utilization_percent`, `node_container_restart_count`, `node_active_connections`), and JSON Handshake Contracts in Section 6 of CONTEXT.md.
3. Enforce the 5-second Prometheus scrape interval and the `> 85%` for `for: 60s` alert rules in `alert_rules.yml`.
4. Ensure `waitingScreen.html` in `smart-lb-controller` has a clean, modern dark-mode UI with a live countdown timer and automatic polling of `/cluster-status` so it auto-refreshes once `machine-1` returns `ONLINE`.
5. Create `CLAUDE.md`, `.env.example`, and a comprehensive `README.md` with architecture diagrams and demo verification commands.
6. After generating all files, run `node --check` on every JavaScript file to verify there are zero syntax errors.
```

---

## 9. Verification Status (2026-10-30)

Each branch was completed, reviewed for bugs and security issues, and tested against sample inputs and expected outputs. Docker was not available on the verification machine, so every test runs in-process with Docker faked. The live cluster check (`remediation-engine/scripts/e2e.ps1`) is still pending.

### 9.1 Branch results

| Branch | Commit | Test command | Result |
| :--- | :--- | :--- | :--- |
| `feat/remediation-engine` | `7b85e23` | `cd remediation-engine && npm test` | 34 / 34 pass |
| `feat/machine-node` | `3215a51` | `cd machine-node && npm test` | 16 / 16 pass |
| `feat/smart-lb` | `660ccbb` | `cd smart-lb-controller && npm test` | 41 / 41 pass |
| `feat/observability-stack` | `aeace0e` | `python -m unittest discover -s observability/tests -v` | 51 / 51 pass |

A trial merge of all four branches onto `main` had no conflicts. All 142 tests pass on the merged tree, and `node --check` passes on every JavaScript file.

### 9.2 Sample inputs and verified outputs

| Component | Input | Verified output |
| :--- | :--- | :--- |
| machine-node | `GET /metrics` | All five `node_*{machine_id="machine-1"}` series, including `node_container_restart_count 0` before any fault, plus default `prom-client` metrics |
| machine-node | `POST /fault/memory` (called twice) | RAM plateaus at 88-90 % and never goes above 90 % of the limit |
| machine-node | `POST /fault/gpu`, `/fault/cpu`, `/fault/container-loop` | GPU ≈ 93 %, CPU ≈ 91.2 % (`/metrics` still responds), restart counter +1 every 5 s and RAM ≈ 88.5 % |
| machine-node | `POST /fault/reset` | Baseline values, buffers freed, all fault timers cleared |
| remediation-engine | Alertmanager v4 payload (fixtures in `remediation-engine/test/fixtures/`) | `202 {"ok":true,"accepted":["machine-1"],"skipped":[]}` |
| remediation-engine | Same alert again within 45 s | `skipped: [{ "reason": "cooldown", "cooldownRemainingSeconds": 45 }]` |
| remediation-engine | Invalid ids (`machine-0`, `../etc`, `machine-1; rm -rf /`) | Ignored; Docker never called |
| remediation-engine | Restart or health check fails | LB is re-sent `REBOOTING` with `etaSeconds: 60` and a "retrying" reason, never `ONLINE`. After 3 failures in 10 min the engine stops restarting that node (`circuit_open`) until `POST /reset/<id>` |
| smart-lb-controller | Contract C `REBOOTING` payload, then `GET /api/gpu-render` with `Accept: application/json` | `503`, `Retry-After: 30`, `{ error, machineId, reason, retryAfterSeconds }` |
| smart-lb-controller | Same request from a browser | `503` countdown HTML with `reason` HTML-escaped (an XSS payload is rendered as inert text) |
| smart-lb-controller | Contract C `ONLINE`, then `GET /api/gpu-render` | Proxied `200` from machine-1; an unreachable or stalled upstream returns a clean `503` JSON |
| observability | Config files | 5 s scrape and evaluation; `> 85` with `for: 60s`; `group_by: [machine_id]`; webhook URL; Promtail `container_name`; Grafana datasource UIDs, 85 % thresholds, Loki and MTTR panels |

### 9.3 Cross-service integration (real code, Docker faked)

The real machine-node, smart-lb-controller and remediation-engine code ran together over HTTP. All 12 checks passed:
- **Fault and alert:** a GPU fault reads 93.5 % on the node, and the webhook returns 202.
- **During the restart:** the LB returns 503 with `Retry-After: 30` and the countdown HTML, and `/cluster-status` shows machine-1 as `REBOOTING` with `["gpu-render"]`.
- **After the restart:** the engine records `success` with `vitalsRecovered` (GPU 9 %), the LB shows `ONLINE` and serves `/api/gpu-render` with 200 again, and the MTTR metrics are recorded.
- **Failure path:** the LB stays `REBOOTING` with a 60 s ETA instead of routing to a dead node.

### 9.4 Security fixes applied
- **Ports:** admin and internal host ports (4000, 5000, 3001-3005, 8081, 8082, 9090, 9093, 3100, 3000) are bound to `127.0.0.1`. Only the `:8080` gateway is public.
- **smart-lb-controller:** fixed the waiting-page template injection and made the machine id safe inside the page script. CORS is limited to GET routes, so websites cannot call `/internal/node-status`. Request bodies are validated, `etaSeconds` is capped, and upstream calls have a hard deadline.
- **machine-node and remediation-engine:** errors return JSON with no stack trace; the memory fault has a hard allocation cap.
- **Alert rules:** the cAdvisor memory rule ignores containers with no memory limit, which prevents a false alert and a restart storm.

### 9.5 Open items
1. Run `powershell -ExecutionPolicy Bypass -File remediation-engine/scripts/e2e.ps1` on a machine with Docker to confirm the live loop and measure MTTR.
2. Check that `gcr.io/cadvisor/cadvisor:v0.49.1` and `grafana/promtail:3.2.1` start on Docker Engine 29+. Like Traefik v3.0, they may report "client version too old".
3. Accepted for the demo: Grafana `admin/admin` with anonymous Viewer access, and the remediation engine has read-write access to the Docker socket (needed for restarts).
