"""Static validation of the observability stack (no Docker, promtool or amtool needed).

Run from the repo root:  python -m unittest discover -s observability/tests -v
"""

import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
OBS = ROOT / "observability"
PROM_YML = OBS / "prometheus" / "prometheus.yml"
RULES_YML = OBS / "prometheus" / "alert_rules.yml"
AM_YML = OBS / "alertmanager" / "alertmanager.yml"
LOKI_YML = OBS / "loki" / "loki-config.yml"
PROMTAIL_YML = OBS / "loki" / "promtail-config.yml"
DS_YML = OBS / "grafana" / "provisioning" / "datasources" / "datasources.yml"
DASH_PROVIDER_YML = OBS / "grafana" / "provisioning" / "dashboards" / "dashboards.yml"
DASHBOARD_JSON = OBS / "grafana" / "provisioning" / "dashboards" / "cluster_overview.json"
COMPOSE_YML = ROOT / "docker-compose.yml"
NODE_METRICS_JS = ROOT / "machine-node" / "src" / "metrics.js"
ENGINE_SRC = ROOT / "remediation-engine" / "src"

SCRAPE_INTERVAL_S = 5
MIN_RANGE_S = 4 * SCRAPE_INTERVAL_S  # rate()/increase() need >= 4 samples
MACHINES = [f"machine-{i}" for i in range(1, 6)]
MACHINE_ID_RE = re.compile(r"^machine-[1-9][0-9]*$")  # remediation-engine MACHINE_ID_PATTERN
INVARIANT_METRICS = [
    "node_ram_usage_percent",
    "node_cpu_load_percent",
    "node_gpu_utilization_percent",
    "node_container_restart_count",
    "node_active_connections",
]
CADVISOR_METRICS = {
    "container_memory_working_set_bytes",
    "container_memory_usage_bytes",
    "container_memory_rss",
    "container_spec_memory_limit_bytes",
    "container_cpu_usage_seconds_total",
    "container_last_seen",
    "container_start_time_seconds",
}
PROMETHEUS_BUILTINS = {"up", "ALERTS", "ALERTS_FOR_STATE", "scrape_duration_seconds", "scrape_samples_scraped"}
PROMQL_KEYWORDS = {
    "by", "without", "on", "ignoring", "group_left", "group_right", "bool", "and", "or", "unless", "offset",
    "inf", "nan",
}
SEVERITIES = {"critical", "warning", "info"}


# ----------------------------------------------------------------------------- helpers
def load_yaml(path):
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


_DUR_PART = re.compile(r"(\d+)(ms|s|m|h|d|w|y)")
_DUR_UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "y": 31536000}


def duration_s(value):
    """Prometheus duration string ('5s', '1m', '1h30m') -> seconds."""
    text = str(value).strip()
    parts = _DUR_PART.findall(text)
    if not parts or "".join(n + u for n, u in parts) != text:
        raise ValueError(f"not a Prometheus duration: {value!r}")
    return sum(int(n) * _DUR_UNITS[u] for n, u in parts)


def range_windows(expr):
    """All range-vector / subquery windows used in a PromQL expression."""
    return [m.group(1) for m in re.finditer(r"\[\s*([0-9a-z]+)\s*(?::[^\]]*)?\]", expr)]


def metric_names(expr):
    """Metric names referenced by a PromQL expression (functions, labels, keywords removed)."""
    e = re.sub(r'"(?:\\.|[^"\\])*"', '""', expr)  # string literals
    e = re.sub(r"\{[^}]*\}", "", e)  # label matchers
    e = re.sub(r"\[[^\]]*\]", "", e)  # range windows
    e = re.sub(r"\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)", "", e)  # label lists
    names = set()
    for m in re.finditer(r"(?<![\w.])([a-zA-Z_:][a-zA-Z0-9_:]*)(\s*\()?", e):
        ident, is_call = m.group(1), m.group(2)
        if is_call or ident.lower() in PROMQL_KEYWORDS:
            continue
        names.add(ident)
    return names


def go_full_match(pattern, value):
    """Prometheus / Loki / relabel regexes are fully anchored."""
    return re.fullmatch(f"(?:{pattern})", value)


def label_replace(labels, dst, replacement, src, regex):
    """Python model of PromQL label_replace() for a single series."""
    m = go_full_match(regex, labels.get(src, ""))
    if not m:
        return dict(labels)
    out = dict(labels)
    value = re.sub(r"\$(\d+)", lambda g: m.group(int(g.group(1))) or "", replacement)
    if value:
        out[dst] = value
    else:
        out.pop(dst, None)
    return out


LABEL_REPLACE_RE = re.compile(
    r'label_replace\(\s*(?P<inner>.*),\s*"(?P<dst>[^"]*)"\s*,\s*"(?P<repl>[^"]*)"\s*,'
    r'\s*"(?P<src>[^"]*)"\s*,\s*"(?P<regex>[^"]*)"\s*\)',
    re.S,
)


def compose_mounts(service):
    """{container_path: host_path} for bind mounts of a compose service."""
    mounts = {}
    for vol in COMPOSE["services"][service].get("volumes", []):
        parts = vol.split(":")
        if parts[0].startswith("./"):
            mounts[parts[1]] = (ROOT / parts[0][2:]).resolve()
    return mounts


def host_path(service, container_path):
    """Resolve a path inside a container to the bind-mounted host path (longest prefix wins)."""
    for cpath, hpath in sorted(compose_mounts(service).items(), key=lambda kv: -len(kv[0])):
        if container_path == cpath:
            return hpath
        if container_path.startswith(cpath.rstrip("/") + "/"):
            return hpath / container_path[len(cpath.rstrip("/")) + 1:]
    return None


def emitted_metrics():
    """Metric names registered via prom-client in machine-node and remediation-engine sources."""
    names = set()
    sources = [NODE_METRICS_JS] + sorted(ENGINE_SRC.glob("*.js"))
    for src in sources:
        text = src.read_text(encoding="utf-8")
        for m in re.finditer(r"new client\.(Gauge|Counter|Histogram|Summary)\(\{\s*name:\s*'([a-zA-Z_:][\w:]*)'", text):
            kind, name = m.groups()
            names.add(name)
            if kind == "Histogram":
                names.update({f"{name}_bucket", f"{name}_sum", f"{name}_count"})
            if kind == "Summary":
                names.update({f"{name}_sum", f"{name}_count"})
    return names


def all_rules():
    return [r for g in RULES["groups"] for r in g["rules"]]


def rule(name):
    matches = [r for r in all_rules() if r.get("alert") == name]
    assert len(matches) == 1, f"expected exactly one rule {name}, found {len(matches)}"
    return matches[0]


def panels(dashboard):
    for p in dashboard.get("panels", []):
        yield p
        yield from p.get("panels", [])  # collapsed rows


def panel_exprs(panel):
    return [t["expr"] for t in panel.get("targets", []) if t.get("expr")]


COMPOSE = load_yaml(COMPOSE_YML)
PROM = load_yaml(PROM_YML)
RULES = load_yaml(RULES_YML)
AM = load_yaml(AM_YML)
LOKI = load_yaml(LOKI_YML)
PROMTAIL = load_yaml(PROMTAIL_YML)
DS = load_yaml(DS_YML)
DASH_PROVIDER = load_yaml(DASH_PROVIDER_YML)
DASHBOARD = load_json(DASHBOARD_JSON)


# ----------------------------------------------------------------------------- helper self-tests
class HelperTests(unittest.TestCase):
    def test_duration_parser(self):
        self.assertEqual(duration_s("5s"), 5)
        self.assertEqual(duration_s("1m"), 60)
        self.assertEqual(duration_s("1h30m"), 5400)
        with self.assertRaises(ValueError):
            duration_s("60")

    def test_metric_name_extraction(self):
        self.assertEqual(metric_names('increase(node_container_restart_count{a="b"}[1m]) > 3'),
                         {"node_container_restart_count"})
        self.assertEqual(metric_names('count(ALERTS{alertstate="firing"}) or vector(0)'), {"ALERTS"})
        self.assertEqual(metric_names('sum by (machine_id) (rate(x_total[1m])) / on(machine_id) y'),
                         {"x_total", "y"})
        self.assertEqual(range_windows("rate(a[30s]) + max_over_time(b[5m:5s])"), ["30s", "5m"])

    def test_label_replace_model(self):
        self.assertEqual(label_replace({"name": "machine-3"}, "machine_id", "$1", "name", "(.*)")["machine_id"],
                         "machine-3")
        # anchored: a partial match must not rewrite the label
        self.assertNotIn("machine_id", label_replace({"name": "xmachine-3"}, "machine_id", "$1", "name", "machine-(.)"))


# ----------------------------------------------------------------------------- parsing
class ParseTests(unittest.TestCase):
    def test_every_yaml_and_json_file_parses(self):
        files = sorted(OBS.rglob("*.yml")) + sorted(OBS.rglob("*.yaml")) + sorted(OBS.rglob("*.json"))
        self.assertGreaterEqual(len(files), 8)
        for f in files:
            with self.subTest(file=str(f.relative_to(ROOT))):
                doc = load_json(f) if f.suffix == ".json" else load_yaml(f)
                self.assertIsInstance(doc, dict)


# ----------------------------------------------------------------------------- prometheus.yml
class PrometheusConfigTests(unittest.TestCase):
    def test_global_intervals_are_5s(self):
        g = PROM["global"]
        self.assertEqual(str(g["scrape_interval"]), "5s")
        self.assertEqual(str(g["evaluation_interval"]), "5s")
        self.assertLess(duration_s(g.get("scrape_timeout", "10s")), duration_s(g["scrape_interval"]))

    def test_no_job_overrides_scrape_interval(self):
        for job in PROM["scrape_configs"]:
            self.assertIn(str(job.get("scrape_interval", "5s")), {"5s"}, job["job_name"])

    def _targets(self):
        out = {}
        for job in PROM["scrape_configs"]:
            for sc in job.get("static_configs", []):
                for t in sc["targets"]:
                    out[t] = job["job_name"]
        return out

    def test_required_targets(self):
        targets = self._targets()
        for t in [f"{m}:3000" for m in MACHINES] + ["cadvisor:8080", "remediation-engine:4000"]:
            self.assertIn(t, targets)
        self.assertEqual({targets[f"{m}:3000"] for m in MACHINES}, {"machine-nodes"})

    def test_job_names_unique(self):
        names = [j["job_name"] for j in PROM["scrape_configs"]]
        self.assertEqual(len(names), len(set(names)))

    def test_targets_are_compose_services(self):
        services = set(COMPOSE["services"])
        for target in self._targets():
            host = target.split(":")[0]
            if host != "localhost":
                self.assertIn(host, services, target)

    def test_rule_files_exist_at_mounted_path(self):
        self.assertTrue(PROM["rule_files"])
        for rf in PROM["rule_files"]:
            hp = host_path("prometheus", rf)
            self.assertIsNotNone(hp, f"{rf} is not bind-mounted into the prometheus container")
            self.assertTrue(hp.is_file(), hp)
            self.assertEqual(hp, RULES_YML.resolve())

    def test_config_file_is_mounted(self):
        self.assertEqual(host_path("prometheus", "/etc/prometheus/prometheus.yml"), PROM_YML.resolve())

    def test_alerting_points_to_alertmanager(self):
        targets = [t for am in PROM["alerting"]["alertmanagers"] for sc in am["static_configs"] for t in sc["targets"]]
        self.assertEqual(targets, ["alertmanager:9093"])


# ----------------------------------------------------------------------------- alert_rules.yml
class AlertRuleTests(unittest.TestCase):
    def test_sustained_resource_rules(self):
        for alert, metric in [("SustainedHighRAM", "node_ram_usage_percent"),
                              ("SustainedHighCPU", "node_cpu_load_percent"),
                              ("SustainedHighGPU", "node_gpu_utilization_percent")]:
            with self.subTest(alert=alert):
                r = rule(alert)
                self.assertEqual(re.sub(r"\s+", " ", r["expr"].strip()), f"{metric} > 85")
                self.assertEqual(str(r["for"]), "60s")

    def test_rogue_container_loop(self):
        r = rule("RogueContainerLoop")
        self.assertEqual(re.sub(r"\s+", " ", r["expr"].strip()), "increase(node_container_restart_count[1m]) > 3")
        self.assertEqual(str(r["for"]), "30s")

    def test_every_rule_is_an_alert_with_for_and_severity(self):
        for r in all_rules():
            with self.subTest(rule=r.get("alert") or r.get("record")):
                self.assertIn("alert", r)
                self.assertGreaterEqual(duration_s(r["for"]), 30, "missing/short 'for' risks restart storms")
                self.assertIn(r.get("labels", {}).get("severity"), SEVERITIES)

    def test_resource_thresholds_are_85_for_60s(self):
        for r in all_rules():
            if r["alert"] == "RogueContainerLoop":
                continue
            with self.subTest(alert=r["alert"]):
                self.assertRegex(r["expr"], r">\s*85\s*$")
                self.assertEqual(str(r["for"]), "60s")

    def test_alert_names_unique(self):
        names = [r["alert"] for r in all_rules()]
        self.assertEqual(len(names), len(set(names)))

    def test_rule_group_interval(self):
        for g in RULES["groups"]:
            self.assertEqual(duration_s(g.get("interval", "5s")), 5, g["name"])

    def test_range_windows_at_least_4x_scrape_interval(self):
        for r in all_rules():
            for w in range_windows(r["expr"]):
                with self.subTest(alert=r["alert"], window=w):
                    self.assertGreaterEqual(duration_s(w), MIN_RANGE_S)

    def test_node_rules_keep_machine_id(self):
        """In-app rules must not aggregate away machine_id (the engine needs it to pick the container)."""
        for r in all_rules():
            if "label_replace" in r["expr"]:
                continue
            with self.subTest(alert=r["alert"]):
                used = metric_names(r["expr"])
                self.assertTrue(used <= set(INVARIANT_METRICS), used)
                agg = re.search(r"\b(sum|avg|min|max|count|topk|bottomk|quantile)\b", r["expr"])
                if agg:
                    self.assertRegex(r["expr"], r"by\s*\([^)]*machine_id")

    def test_cadvisor_rules_produce_valid_machine_id(self):
        """Simulate label_replace on every compose container name the name=~ matcher selects."""
        cadvisor_rules = [r for r in all_rules() if "label_replace" in r["expr"]]
        self.assertEqual({r["alert"] for r in cadvisor_rules}, {"ContainerMemoryNearLimit", "ContainerCpuSaturated"})
        container_names = {svc: cfg.get("container_name", svc) for svc, cfg in COMPOSE["services"].items()}
        for r in cadvisor_rules:
            m = LABEL_REPLACE_RE.search(r["expr"])
            self.assertIsNotNone(m, r["alert"])
            self.assertEqual(m.group("dst"), "machine_id")
            self.assertEqual(m.group("src"), "name")
            matchers = set(re.findall(r'name=~"([^"]+)"', m.group("inner")))
            self.assertEqual(len(matchers), 1, "all selectors must use the same name matcher")
            matcher = matchers.pop()
            selected = sorted(n for n in container_names.values() if go_full_match(matcher, n))
            with self.subTest(alert=r["alert"]):
                self.assertEqual(selected, MACHINES)  # never selects remediation-engine, cadvisor, ...
                for name in selected:
                    out = label_replace({"name": name}, m.group("dst"), m.group("repl"), m.group("src"), m.group("regex"))
                    self.assertEqual(out.get("machine_id"), name)
                    self.assertRegex(out["machine_id"], MACHINE_ID_RE)

    def test_compose_container_names_match_machine_ids(self):
        """cAdvisor's `name` label is the docker container name; it must equal MACHINE_ID."""
        for m in MACHINES:
            svc = COMPOSE["services"][m]
            self.assertEqual(svc.get("container_name"), m)
            self.assertEqual(svc["environment"]["MACHINE_ID"], m)

    def test_memory_ratio_guards_unlimited_containers(self):
        expr = rule("ContainerMemoryNearLimit")["expr"]
        self.assertRegex(expr, r"container_spec_memory_limit_bytes\{[^}]*\}\s*>\s*0")

    def test_alerts_use_only_emitted_metrics(self):
        known = emitted_metrics() | CADVISOR_METRICS | PROMETHEUS_BUILTINS
        for r in all_rules():
            with self.subTest(alert=r["alert"]):
                self.assertTrue(metric_names(r["expr"]) <= known, metric_names(r["expr"]) - known)


# ----------------------------------------------------------------------------- alertmanager.yml
class AlertmanagerTests(unittest.TestCase):
    def test_route_grouping_and_timers(self):
        route = AM["route"]
        self.assertIn("machine_id", route["group_by"])
        self.assertNotIn("...", route["group_by"])
        self.assertEqual(str(route["group_wait"]), "2s")
        self.assertEqual(str(route["group_interval"]), "5s")
        repeat = duration_s(route["repeat_interval"])
        self.assertGreaterEqual(repeat, 60)  # longer than the engine's 45s cooldown
        self.assertLessEqual(repeat, 3600)

    def test_every_receiver_reference_resolves(self):
        names = {r["name"] for r in AM["receivers"]}

        def walk(route):
            yield route.get("receiver")
            for child in route.get("routes", []):
                yield from walk(child)

        for ref in walk(AM["route"]):
            if ref is not None:
                self.assertIn(ref, names)

    def test_default_receiver_is_remediation_webhook(self):
        rcv = next(r for r in AM["receivers"] if r["name"] == AM["route"]["receiver"])
        urls = [w["url"] for w in rcv["webhook_configs"]]
        self.assertEqual(urls, ["http://remediation-engine:4000/webhook"])
        self.assertIn("remediation-engine", COMPOSE["services"])
        self.assertEqual(COMPOSE["services"]["remediation-engine"]["environment"]["PORT"], "4000")

    def test_config_file_is_mounted(self):
        self.assertEqual(host_path("alertmanager", "/etc/alertmanager/alertmanager.yml"), AM_YML.resolve())


# ----------------------------------------------------------------------------- loki / promtail
class LokiPromtailTests(unittest.TestCase):
    def test_loki_listens_on_3100_single_tenant(self):
        self.assertEqual(LOKI["server"]["http_listen_port"], 3100)
        self.assertIs(LOKI["auth_enabled"], False)  # promtail sends no X-Scope-OrgID

    def test_loki3_schema_is_tsdb_v13(self):
        image = COMPOSE["services"]["loki"]["image"]
        major = int(re.search(r":(\d+)\.", image).group(1))
        self.assertGreaterEqual(major, 3)
        for cfg in LOKI["schema_config"]["configs"]:
            self.assertEqual(cfg["store"], "tsdb")
            self.assertEqual(cfg["schema"], "v13")
            self.assertEqual(cfg["object_store"], "filesystem")

    def test_loki_storage_lives_on_the_data_volume(self):
        volumes = COMPOSE["services"]["loki"]["volumes"]
        self.assertIn("loki-data:/loki", volumes)
        self.assertTrue(LOKI["common"]["path_prefix"].startswith("/loki"))
        for key, path in LOKI["common"]["storage"]["filesystem"].items():
            self.assertTrue(path.startswith("/loki/"), key)

    def test_promtail_pushes_to_loki(self):
        self.assertEqual([c["url"] for c in PROMTAIL["clients"]], ["http://loki:3100/loki/api/v1/push"])

    def test_promtail_positions_on_volume(self):
        self.assertTrue(PROMTAIL["positions"]["filename"].startswith("/promtail/"))
        self.assertIn("promtail-data:/promtail", COMPOSE["services"]["promtail"]["volumes"])

    def test_promtail_docker_socket_is_mounted_read_only(self):
        job = next(j for j in PROMTAIL["scrape_configs"] if "docker_sd_configs" in j)
        host = job["docker_sd_configs"][0]["host"]
        self.assertEqual(host, "unix:///var/run/docker.sock")
        self.assertIn("/var/run/docker.sock:/var/run/docker.sock:ro", COMPOSE["services"]["promtail"]["volumes"])

    def _relabel(self, meta):
        """Python model of Prometheus relabel 'replace' action (default)."""
        job = next(j for j in PROMTAIL["scrape_configs"] if "docker_sd_configs" in j)
        labels = dict(meta)
        for rc in job["relabel_configs"]:
            action = rc.get("action", "replace")
            self.assertEqual(action, "replace")
            value = rc.get("separator", ";").join(labels.get(s, "") for s in rc["source_labels"])
            m = go_full_match(rc.get("regex", "(.*)"), value)
            if not m:
                continue
            new = re.sub(r"\$\{?(\d+)\}?", lambda g: m.group(int(g.group(1))) or "", rc.get("replacement", "$1"))
            if new:
                labels[rc["target_label"]] = new
        return {k: v for k, v in labels.items() if not k.startswith("__")}

    def test_promtail_produces_container_name_label(self):
        for name in MACHINES + ["remediation-engine", "smart-lb-controller"]:
            out = self._relabel({"__meta_docker_container_name": f"/{name}",
                                 "__meta_docker_container_label_com_docker_compose_service": name})
            self.assertEqual(out["container_name"], name)

    def test_config_files_are_mounted(self):
        self.assertEqual(host_path("loki", "/etc/loki/loki-config.yml"), LOKI_YML.resolve())
        self.assertEqual(host_path("promtail", "/etc/promtail/promtail-config.yml"), PROMTAIL_YML.resolve())


# ----------------------------------------------------------------------------- grafana
class GrafanaTests(unittest.TestCase):
    def _ds(self, typ):
        return next(d for d in DS["datasources"] if d["type"] == typ)

    def test_datasources(self):
        self.assertEqual(self._ds("prometheus")["url"], "http://prometheus:9090")
        self.assertEqual(self._ds("loki")["url"], "http://loki:3100")
        uids = [d["uid"] for d in DS["datasources"]]
        self.assertEqual(len(uids), len(set(uids)))
        self.assertEqual(sum(1 for d in DS["datasources"] if d.get("isDefault")), 1)

    def test_every_datasource_reference_resolves(self):
        provisioned = {(d["uid"], d["type"]) for d in DS["datasources"]}
        for p in panels(DASHBOARD):
            refs = [p.get("datasource")] + [t.get("datasource") for t in p.get("targets", [])]
            for ref in refs:
                if ref is None:
                    continue
                with self.subTest(panel=p["title"]):
                    self.assertIsInstance(ref, dict, "datasource must be referenced by uid, not name")
                    self.assertIn((ref["uid"], ref["type"]), provisioned)

    def test_panel_ids_unique(self):
        ids = [p["id"] for p in panels(DASHBOARD)]
        self.assertEqual(len(ids), len(set(ids)))

    def test_resource_panels_have_85_threshold_line(self):
        for metric in ["node_ram_usage_percent", "node_cpu_load_percent", "node_gpu_utilization_percent"]:
            with self.subTest(metric=metric):
                ps = [p for p in panels(DASHBOARD) if p["type"] == "timeseries"
                      and any(metric in e for e in panel_exprs(p))]
                self.assertEqual(len(ps), 1)
                p = ps[0]
                self.assertTrue(any("{{machine_id}}" in t.get("legendFormat", "") for t in p["targets"]))
                defaults = p["fieldConfig"]["defaults"]
                self.assertIn(85, [s["value"] for s in defaults["thresholds"]["steps"]])
                self.assertIn(defaults["custom"]["thresholdsStyle"]["mode"], {"line", "dashed", "line+area", "dashed+area"})
                self.assertEqual(defaults["unit"], "percent")

    def test_firing_alerts_panel(self):
        ps = [p for p in panels(DASHBOARD) if any(re.search(r'ALERTS\{[^}]*alertstate="firing"', e)
                                                   for e in panel_exprs(p))]
        self.assertTrue(any(p["type"] == "table" for p in ps))

    def test_loki_logs_panel_covers_spec_containers(self):
        ps = [p for p in panels(DASHBOARD) if p["type"] == "logs"]
        self.assertTrue(ps)
        spec = 'machine-.*|remediation-engine'
        found = False
        for p in ps:
            self.assertEqual(p["datasource"]["type"], "loki")
            for e in panel_exprs(p):
                m = re.match(r'\{container_name=~"([^"]+)"\}', e)
                self.assertIsNotNone(m, e)
                regex = m.group(1)
                for name in MACHINES + ["remediation-engine"]:
                    self.assertTrue(go_full_match(regex, name), (regex, name))
                for noisy in ["prometheus", "grafana", "loki", "promtail", "cadvisor", "alertmanager"]:
                    self.assertFalse(go_full_match(regex, noisy), (regex, noisy))
                found = found or regex.startswith(spec)
        self.assertTrue(found, "no logs panel selects the spec container set")

    def test_mttr_panels_use_remediation_metrics(self):
        mttr = [p for p in panels(DASHBOARD) if "MTTR" in p["title"]]
        self.assertGreaterEqual(len(mttr), 1)
        for p in mttr:
            self.assertTrue(any(re.search(r"\bremediation_\w*duration_seconds", e) for e in panel_exprs(p)), p["title"])
        self.assertTrue(any("remediation_total" in e for p in panels(DASHBOARD) for e in panel_exprs(p)))

    def test_dashboard_metrics_are_emitted(self):
        known = emitted_metrics() | CADVISOR_METRICS | PROMETHEUS_BUILTINS
        for p in panels(DASHBOARD):
            if p.get("datasource", {}).get("type") != "prometheus":
                continue
            for e in panel_exprs(p):
                with self.subTest(panel=p["title"]):
                    self.assertTrue(metric_names(e) <= known, metric_names(e) - known)

    def test_dashboard_job_selectors_exist(self):
        jobs = {j["job_name"] for j in PROM["scrape_configs"]}
        for p in panels(DASHBOARD):
            for e in panel_exprs(p):
                for job in re.findall(r'job="([^"]+)"', e):
                    self.assertIn(job, jobs, p["title"])

    def test_dashboard_range_windows(self):
        for p in panels(DASHBOARD):
            if p.get("datasource", {}).get("type") != "prometheus":
                continue
            for e in panel_exprs(p):
                for w in range_windows(e):
                    self.assertGreaterEqual(duration_s(w), MIN_RANGE_S, (p["title"], e))

    def test_dashboard_provider_points_at_dashboard(self):
        provider = DASH_PROVIDER["providers"][0]
        self.assertEqual(provider["type"], "file")
        hp = host_path("grafana", provider["options"]["path"])
        self.assertEqual((hp / DASHBOARD_JSON.name).resolve(), DASHBOARD_JSON.resolve())
        home = COMPOSE["services"]["grafana"]["environment"].get("GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH")
        if home:
            self.assertEqual(host_path("grafana", home), DASHBOARD_JSON.resolve())
        self.assertEqual(host_path("grafana", "/etc/grafana/provisioning/datasources/datasources.yml"), DS_YML.resolve())


# ----------------------------------------------------------------------------- source cross-checks
class SourceCrossCheckTests(unittest.TestCase):
    def test_machine_node_emits_invariant_metrics_with_machine_id(self):
        text = NODE_METRICS_JS.read_text(encoding="utf-8")
        for metric in INVARIANT_METRICS:
            with self.subTest(metric=metric):
                m = re.search(rf"name:\s*'{metric}'.*?labelNames:\s*\[([^\]]*)\]", text, re.S)
                self.assertIsNotNone(m)
                self.assertIn("'machine_id'", m.group(1))

    def test_remediation_engine_emits_mttr_metrics(self):
        names = emitted_metrics()
        for metric in ["remediation_total", "remediation_duration_seconds_bucket", "remediation_last_duration_seconds"]:
            self.assertIn(metric, names)

    def test_engine_machine_id_pattern_matches_tests(self):
        text = (ENGINE_SRC / "index.js").read_text(encoding="utf-8")
        self.assertIn("/^machine-[1-9][0-9]*$/", text)

    def test_engine_serves_metrics_and_webhook(self):
        text = (ENGINE_SRC / "index.js").read_text(encoding="utf-8")
        self.assertIn("app.get('/metrics'", text)
        self.assertIn("app.post('/webhook'", text)


if __name__ == "__main__":
    unittest.main()
