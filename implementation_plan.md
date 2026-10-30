# Implementation Plan: Distributed Self-Healing Cluster & Smart Load-Balancing System

## 1. System Overview & Core Architecture
An automated, cluster-aware fault-recovery architecture deployed across a 5-machine server cluster (`machine-1` through `machine-5`) behind **Traefik** and a **Smart Load Balancer Controller**.

When any machine experiences sustained hardware exhaustion (**RAM, CPU, or GPU $> 85\%$ for $\ge 60$ seconds**) caused by issues like runaway Docker container spin-up loops, memory leaks, or compute spikes, the system executes an automated self-healing workflow without human intervention:

1. **Out-of-Band & In-App Telemetry:** **cAdvisor** (kernel cgroup container metrics) and the local **Node Agent** (`prom-client` + `systeminformation` with `SIMULATE_GPU=true` fallback) expose real-time vitals to **Prometheus** at a strict **5-second scrape interval**.
2. **Crash-Proof Log Preservation:** **Promtail** tails container logs across all 5 machines and streams them to **Grafana Loki** in real time so forensic crash logs are preserved before a container is restarted.
3. **Sustained Anomaly Evaluation:** **Prometheus** evaluates alert rules (`> 85%` RAM, CPU, or GPU sustained for `>= 60s`) and fires alerts to **Alertmanager**, which dispatches HTTP POST JSON webhooks to the **Remediation Engine**.
4. **Pre-Reboot Load Balancer Handshake:** Before restarting the choking node, the **Remediation Engine** sends an urgent pre-reboot payload (`status: "REBOOTING"`, `etaSeconds: 30`, `exclusiveServices`) to the **Smart LB Controller**.
5. **Intelligent Dual-Mode Traffic Handling:**
   * **Replicated Services (`/api/shared` on Machines 1–5):** **Traefik** health checks and the LB Controller automatically route user traffic to healthy nodes (`machine-2..5`) with zero dropped requests.
   * **Exclusive Services (`/api/gpu-render` ONLY on `machine-1`):** Instead of hanging or throwing a generic `502 Bad Gateway`, the **Smart LB Controller** intercepts the request and renders a live **"Service Self-Healing in Progress (ETA Countdown)"** waiting screen (`waitingScreen.html`) or JSON response that automatically refreshes once the machine recovers.
6. **Programmatic Remediation (`Dockerode`):** The **Remediation Engine** interacts directly with the host Docker daemon (`/var/run/docker.sock`) via **Dockerode** to stop rogue container loops, restart the affected container, verify metrics drop below $50\%$, and signal `"status": "ONLINE"` back to the Load Balancer.

---

## 2. Complete Tech Stack & Component Responsibilities

| Technology | Location | Core Functionality |
| :--- | :--- | :--- |
| **Node.js (Express)** | `machine-1..5`, `remediation-engine`, `smart-lb-controller` | Powers the target microservices, telemetry agent, fault injection routes, Dockerode webhook listener, and Smart LB state registry. |
| **Traefik (v3.0)** | Edge Reverse Proxy (`:8080`) | Hooks into `/var/run/docker.sock` to auto-discover `machine-1..5`, run 2-second health checks, balance shared services, and route exclusive service requests through the Smart LB Controller. |
| **cAdvisor** | Host Monitoring (`:8082`) | Collects container-level RAM and CPU metrics directly from the Docker daemon so Prometheus still detects spikes even if a Node.js event loop freezes completely. |
| **`prom-client` & `systeminformation`** | `machine-1..5` (`/metrics`) | Exposes process heap, RSS, CPU load, container restart counters, and physical/simulated GPU utilization (`node_gpu_utilization_percent`). |
| **Prometheus** | Observability Plane (`:9090`) | Scrapes all 5 machines and cAdvisor every **5 seconds** and evaluates the sustained **$> 85\%$ for $\ge 60\text{s}$** alert rules. |
| **Alertmanager** | Observability Plane (`:9093`) | Deduplicates firing alerts from Prometheus and dispatches HTTP POST webhooks to `http://remediation-engine:4000/webhook`. |
| **Dockerode** | `remediation-engine` (`:4000`) | Connects to `/var/run/docker.sock` to programmatically restart unhealthy containers or clean up runaway container loops without fragile bash scripts. |
| **Grafana Loki & Promtail** | Observability Plane (`:3100`) | Aggregates and indexes stdout/stderr logs from all containers prior to remediation restarts. |
| **Grafana** | Observability Plane (`:3000`) | Displays live cluster status panels, RAM/CPU/GPU time-series graphs with $85\%$ threshold lines, MTTR metrics, and live Loki log streams. |

---

## 3. Target Workspace Directory Structure

Instruct the coding agent to scaffold the following exact workspace tree:

```text
self-healing-cluster/
├── docker-compose.yml
├── .env.example
├── README.md
├── machine-node/                  # Person 1: Deployed as 5 instances (machine-1 to machine-5)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # Express app (/health, /api/shared, /api/gpu-render)
│       ├── metrics.js             # prom-client + systeminformation (RAM, CPU, GPU + SIMULATE_GPU)
│       └── faultRoutes.js         # Deterministic faults (/fault/memory, /cpu, /gpu, /container-loop)
├── remediation-engine/            # Person 2: Dockerode-powered self-healing engine
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # POST /webhook listener + 45s cooldown guard
│       └── dockerController.js    # Pre-reboot LB handshake + Dockerode container restart
├── smart-lb-controller/           # Person 3: Traffic Gatekeeper & Live Waiting UI
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js               # Express server (/internal/node-status, /cluster-status, proxy)
│       ├── stateRegistry.js       # In-memory state table (ONLINE vs REBOOTING + ETA timestamp)
│       └── views/
│           └── waitingScreen.html # Live JS countdown UI for rebooting exclusive services
└── observability/                 # Person 4: Monitoring, Alerting, Logs & Dashboards
    ├── prometheus/
    │   ├── prometheus.yml         # 5s scrape config for machine-1..5 & cAdvisor
    │   └── alert_rules.yml        # >85% RAM, CPU, GPU for >=60s rules
    ├── alertmanager/
    │   └── alertmanager.yml       # Dispatches HTTP POST webhooks to remediation-engine:4000
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

## 4. 4-Person Role Matrix & Frozen API Contracts

### 4.1 Team Division (Zero Merge Conflict Ownership)
* **Person 1 — Target Node, Telemetry & Chaos Engineer (`/machine-node`):** Builds the Node.js service, `/metrics` endpoint (`prom-client` + `systeminformation`), `SIMULATE_GPU=true` support, and deterministic fault injection routes (`/fault/memory`, `/fault/cpu`, `/fault/gpu`, `/fault/container-loop`).
* **Person 2 — Orchestration & Dockerode Remediation Engineer (`/remediation-engine` & `docker-compose.yml`):** Builds the Alertmanager webhook receiver (`POST /webhook`), implements the 45-second per-node cooldown lock, executes the pre-reboot handshake with the Smart LB Controller, and uses `dockerode` to restart containers and verify recovery.
* **Person 3 — Smart Load Balancer, Traefik & Waiting UI Lead (`/smart-lb-controller`):** Configures Traefik labels in `docker-compose.yml`, builds the Node State Registry (`POST /internal/node-status`), proxies healthy exclusive services, and builds the live auto-refreshing `waitingScreen.html` countdown UI when `machine-1` is `REBOOTING`.
* **Person 4 — Observability, Loki Logs & Grafana Lead (`/observability`):** Configures Prometheus (`5s` scrape), writes the PromQL alert rules (`> 85%` for `>= 60s`), configures Alertmanager webhooks, sets up Loki + Promtail log streaming, and provisions the Grafana dashboard.

### 4.2 Frozen Port Allocations
* `8080`: Traefik Public Gateway (`http://localhost:8080/api/shared` & `/api/gpu-render`)
* `8081`: Traefik Internal Dashboard
* `5000`: Smart LB Controller (`POST /internal/node-status`, `GET /cluster-status`)
* `4000`: Remediation Engine (`POST /webhook`)
* `3001`–`3005`: Host ports mapped to `machine-1` through `machine-5` (internal port `3000`)
* `9090`: Prometheus | `9093`: Alertmanager | `3000`: Grafana | `3100`: Loki | `8082`: cAdvisor

### 4.3 Frozen JSON Contracts

#### Contract A: Telemetry Metric Names (`GET /metrics` on `machine-1..5`)
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
```

#### Contract B: Pre-Reboot & Post-Recovery Handshake (`Remediation Engine` $\rightarrow$ `Smart LB Controller`)
Endpoint: `POST http://smart-lb-controller:5000/internal/node-status`

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

## 5. Phase-by-Phase Technical Implementation Specs

### Phase 1: Machine Node & Telemetry Agent (`./machine-node`)
1. **Dependencies:** `express`, `prom-client`, `systeminformation`.
2. **Environment Variables:** `MACHINE_ID` (`machine-1`..`machine-5`), `PORT=3000`, `CONTAINER_MEM_LIMIT_MB=256`, `SIMULATE_GPU=true`, `EXCLUSIVE_SERVICE=true` (true on `machine-1`, false on `machine-2..5`).
3. **Endpoints (`src/index.js`):**
   * `GET /health`: Returns `200 OK` `{ status: "healthy", machineId }` during normal operation, or `503` if draining.
   * `GET /api/shared`: Returns `200 OK` `{ machineId, service: "shared-api", status: "ok", timestamp }`.
   * `GET /api/gpu-render`: On `machine-1`, returns `200 OK` `{ machineId: "machine-1", service: "gpu-renderer", status: "Rendered Frame" }`.
4. **Telemetry Instrumentation (`src/metrics.js`):**
   * Collect default Node.js metrics (`process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `process_cpu_seconds_total`) via `prom-client`.
   * Calculate `node_ram_usage_percent` as `(process.memoryUsage().rss / (CONTAINER_MEM_LIMIT_MB * 1024 * 1024)) * 100` (or active fault override).
   * Calculate `node_cpu_load_percent` via `systeminformation.currentLoad()`.
   * Calculate `node_gpu_utilization_percent`: if `SIMULATE_GPU=true` or no physical GPU is returned by `systeminformation.graphics()`, report baseline $8\%\text{--}15\%$ unless spiked by `/fault/gpu`.
5. **Deterministic Fault Injection (`src/faultRoutes.js`):**
   * `POST /fault/memory`: Allocates uncollected `Buffer.alloc(10 * 1024 * 1024)` chunks every 500ms until usage plateaus at **$88\%\text{--}90\%$** of the `256MB` limit (ensuring it stays $> 85\%$ for the full $60\text{s}$ Prometheus evaluation window without triggering an immediate Docker OOM kill). Logs `[FAULT] Memory leak injected on ${MACHINE_ID}` to stdout for Loki.
   * `POST /fault/cpu`: Runs a non-blocking interval compute saturation loop pushing `node_cpu_load_percent` to **$89\%\text{--}93\%$**.
   * `POST /fault/gpu`: Sets `node_gpu_utilization_percent` to **$92\%$** and logs `[FAULT] GPU saturation triggered on ${MACHINE_ID}`.
   * `POST /fault/container-loop`: Increments `node_container_restart_count` every 5 seconds and spikes RAM to **$88\%$** to simulate a runaway container spin-up loop.
   * `POST /fault/reset`: Frees allocated buffers and resets all fault states to baseline.

---

### Phase 2: Dockerode Remediation Engine (`./remediation-engine`)
1. **Dependencies:** `express`, `dockerode`, `axios`.
2. **Volume Mount:** Mount `/var/run/docker.sock:/var/run/docker.sock` in `docker-compose.yml`.
3. **Webhook Logic (`src/index.js` & `src/dockerController.js`):**
   * Listen on `POST /webhook`.
   * Iterate through `req.body.alerts` where `alert.status === "firing"`.
   * Extract `machineId = alert.labels.machine_id || alert.labels.instance.split(':')[0]`.
   * **Cooldown Check:** Check `cooldownMap.get(machineId)`. If remediated within the last 45 seconds, log and skip to prevent duplicate reboot loops.
   * **Step 1 (Pre-Reboot Notification):** Send `POST http://smart-lb-controller:5000/internal/node-status` with `status: "REBOOTING"` and `etaSeconds: 30`.
   * **Step 2 (Dockerode Restart):** Find the container matching `machineId` via `docker.listContainers()` (matching container name or label `com.docker.compose.service === machineId`) and execute `await container.restart({ t: 5 })`.
   * **Step 3 (Verify & Restore):** Poll `http://${machineId}:3000/health` every 2 seconds until it responds `200 OK`, then send `POST http://smart-lb-controller:5000/internal/node-status` with `status: "ONLINE"`.

---

### Phase 3: Smart Load Balancer Controller & Waiting UI (`./smart-lb-controller`)
1. **Dependencies:** `express`, `http-proxy-middleware` (or `axios`), `cors`.
2. **State Registry (`src/stateRegistry.js`):**
   * Initialize state for `machine-1` through `machine-5` as `{ status: "ONLINE", reason: null, etaTimestamp: null, exclusiveServices: [] }`.
   * Expose `POST /internal/node-status` to update machine state. When `status === "REBOOTING"`, compute `etaTimestamp = Date.now() + (etaSeconds * 1000)`.
   * Expose `GET /cluster-status` returning the JSON state of all 5 machines (also used by `waitingScreen.html` to poll live status).
3. **Exclusive Service Interception (`src/index.js` & `src/views/waitingScreen.html`):**
   * Handle `GET /api/gpu-render`:
     * Check `stateRegistry.get("machine-1")`.
     * If `ONLINE`, proxy the request to `http://machine-1:3000/api/gpu-render` and return the `200 OK` response.
     * If `REBOOTING`, calculate `remainingSeconds = Math.max(1, Math.ceil((etaTimestamp - Date.now()) / 1000))`.
     * Set HTTP status `503 Service Unavailable` and header `Retry-After: ${remainingSeconds}`.
     * If `req.accepts('html')`, render `waitingScreen.html` with dynamic values (`machine-1`, `reason`, `remainingSeconds`). The HTML page includes a clean dark-mode status card, a live progress bar, a 1-second JS countdown timer, and a `fetch('/cluster-status')` poller every 3 seconds that automatically reloads the page the instant `machine-1` transitions back to `ONLINE`.
     * Otherwise, return JSON `{ error: "Service Temporarily Rebooting", machineId: "machine-1", reason, retryAfterSeconds: remainingSeconds }`.

---

### Phase 4: Observability Pipeline (`./observability` & `docker-compose.yml`)
1. **Prometheus (`prometheus.yml` & `alert_rules.yml`):**
   * Global `scrape_interval: 5s`, `evaluation_interval: 5s`.
   * Scrape `machine-1:3000` through `machine-5:3000` and `cadvisor:8080`.
   * Define alert rules in `alert_rules.yml` with `for: 60s`:
     * `SustainedHighRAM`: `node_ram_usage_percent > 85` (for `60s`)
     * `SustainedHighCPU`: `node_cpu_load_percent > 85` (for `60s`)
     * `SustainedHighGPU`: `node_gpu_utilization_percent > 85` (for `60s`)
     * `RogueContainerLoop`: `increase(node_container_restart_count[1m]) > 3` (for `30s`)
2. **Alertmanager (`alertmanager.yml`):**
   * Set `group_wait: 5s`, `group_interval: 5s`, `repeat_interval: 2m`.
   * Route all alerts to receiver `remediation-engine` at `http://remediation-engine:4000/webhook`.
3. **Loki & Promtail (`loki-config.yml` & `promtail-config.yml`):**
   * Configure Promtail to discover Docker containers via `/var/run/docker.sock`, attach the `container_name` label, and push logs to `http://loki:3100/loki/api/v1/push`.
4. **Grafana Auto-Provisioning (`datasources.yml` & `cluster_overview.json`):**
   * Provision Prometheus (`http://prometheus:9090`) and Loki (`http://loki:3100`) datasources automatically.
   * Provision `cluster_overview.json` containing:
     * Real-time RAM %, CPU %, and GPU % time-series graphs for `machine-1..5` with an $85\%$ threshold line.
     * Current firing alerts panel.
     * Live Loki logs panel filtering `{container_name=~"machine-.*|remediation-engine"}`.
5. **Root `docker-compose.yml`:**
   * Define `traefik`, `smart-lb-controller`, `remediation-engine`, `machine-1`..`machine-5` (each with `mem_limit: 256m`), `cadvisor`, `prometheus`, `alertmanager`, `loki`, `promtail`, and `grafana` on bridge network `self-healing-net`.
   * Configure Traefik labels:
     * Route `PathPrefix(/api/shared)` across `machine-1`..`machine-5` with healthcheck `/health` (`interval=2s`).
     * Route `PathPrefix(/api/gpu-render)` and `PathPrefix(/cluster-status)` to `smart-lb-controller:5000`.

---

## 6. End-to-End Verification & Demo Script

1. **Build and Boot the Cluster:**
   ```bash
   docker compose up -d --build
   ```
2. **Verify Baseline Traffic:**
   * `curl http://localhost:8080/api/shared` $\rightarrow$ Returns `200 OK` balanced across `machine-1` through `machine-5`.
   * Open `http://localhost:8080/api/gpu-render` in browser $\rightarrow$ Returns `200 OK` from `machine-1`.
3. **Inject Fault on `machine-1` (RAM + GPU $> 85\%$):**
   ```bash
   curl -X POST http://localhost:3001/fault/memory
   curl -X POST http://localhost:3001/fault/gpu
   ```
4. **Observe the 60-Second Detection Window:**
   * Open Grafana (`http://localhost:3000`) and watch `machine-1` RAM and GPU cross the $85\%$ threshold line while Loki displays the fault injection logs.
   * After $\ge 60$ seconds, Prometheus transitions the alert to `FIRING` and Alertmanager dispatches the webhook to `remediation-engine`.
5. **Verify Smart Traffic Handling During Reboot:**
   * Refresh `http://localhost:8080/api/gpu-render` in the browser $\rightarrow$ Displays the **Live Self-Healing Countdown Screen** (*"machine-1 is rebooting due to Sustained Resource Exhaustion (>85% for >=60s). Back online in XXs..."*).
   * Run `curl http://localhost:8080/api/shared` $\rightarrow$ Continues returning `200 OK` from `machine-2..5` with zero failed requests.
6. **Confirm Self-Healing Recovery:**
   * `remediation-engine` restarts `machine-1` via `Dockerode`.
   * Once `machine-1` boots back up with RAM/GPU back at baseline ($\sim 15\%$), it notifies `smart-lb-controller` (`status: "ONLINE"`), and the browser waiting screen automatically refreshes to show the working `/api/gpu-render` response.

---

## 7. Implementation & Verification Status (2026-10-30)

Full results are in `project_context_claude_code_guide.md` §9.

- [x] **Phase 1 – machine-node** (`feat/machine-node`, 16 tests): all routes and faults match the spec; restart counter exported at 0; memory fault capped; JSON errors.
- [x] **Phase 2 – remediation-engine** (`feat/remediation-engine`, 34 tests): webhook → `REBOOTING` handshake → `container.restart({ t: 5 })` → `/health` poll → metrics < 50 % → `ONLINE`, with the 45 s cooldown. Added: the LB stays `REBOOTING` on failure, the node is restarted even when the LB is down, and restarts stop after repeated failures.
- [x] **Phase 3 – smart-lb-controller** (`feat/smart-lb`, 41 tests): registry, `/cluster-status`, `/api/gpu-render` proxy and 503 gate with `Retry-After`, HTML/JSON chosen by `Accept`, escaped waiting screen.
- [x] **Phase 4 – observability** (`feat/observability-stack`, 51 config checks): 5 s scrape, `> 85` for 60 s, Alertmanager → `remediation-engine:4000/webhook`, Loki/Promtail, Grafana provisioning.
- [x] **Integration:** all four branches merge without conflicts; 142 tests pass on the merged tree; a 12-check cross-service run of the real code (Docker faked) covers fault → alert → 503 gate → restart → `ONLINE`, plus the failure path.
- [x] **§6 demo on a live cluster:** run on Docker 29.9.2. 12 self-heals took 4.3-6.7 s each, with 0 failed `/api/shared` requests and the countdown page during machine-1 reboots.
- [x] **Multi-machine:** `deploy/multihost/` (server + per-machine compose files), checked with 5 separate Docker daemons; remote restarts go over TLS.
- [ ] **Smart LB health probe for machine-1:** makes losing the whole host show the countdown immediately (see context doc §9.6).
