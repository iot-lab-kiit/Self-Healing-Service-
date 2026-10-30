<#
  Live end-to-end check of the self-healing loop against the real cluster.
  Run from the repo root:   powershell -ExecutionPolicy Bypass -File remediation-engine/scripts/e2e.ps1
  Add -Quick to skip the 60s Prometheus wait and drive the engine with a fixture webhook instead.
  Add -NoBuild to reuse a cluster that is already up.
#>
param([switch]$Quick, [switch]$NoBuild)

$ErrorActionPreference = 'Stop'
$failures = 0

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Pass($msg) { Write-Host "  PASS $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; $script:failures++ }

# Returns the HTTP status code without throwing on 4xx/5xx (PowerShell 5.1 safe)
function Get-Status($url, $accept = '*/*') {
  $code = & curl.exe -s -o NUL -w '%{http_code}' -H "Accept: $accept" $url
  return [int]$code
}

function Wait-Until($what, $timeoutSec, [scriptblock]$cond) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $r = & $cond; if ($r) { return $r } } catch { }
    Start-Sleep -Seconds 2
  }
  throw "timed out after ${timeoutSec}s waiting for $what"
}

if (-not $NoBuild) {
  Step 'Booting cluster'
  docker compose up -d --build | Out-Host
}

Step 'Waiting for services'
Wait-Until 'remediation-engine /health' 120 { (Invoke-RestMethod http://localhost:4000/health).status -eq 'healthy' } | Out-Null
Wait-Until 'machine-1 /health' 120 { (Invoke-RestMethod http://localhost:3001/health).status -eq 'healthy' } | Out-Null
Wait-Until 'gpu-render 200' 120 { (Get-Status http://localhost:8080/api/gpu-render) -eq 200 } | Out-Null
Invoke-RestMethod -Method Post http://localhost:3001/fault/reset | Out-Null
Invoke-RestMethod -Method Post http://localhost:4000/reset/machine-1 | Out-Null
Pass 'cluster healthy, machine-1 faults and remediation cooldown cleared'

$before = (Invoke-RestMethod http://localhost:4000/status).history.Count
$t0 = Get-Date

if ($Quick) {
  Step 'Posting fixture webhook directly to the engine (no 60s wait)'
  $fixture = Join-Path $PSScriptRoot '..\test\fixtures\firing-ram-machine1.json'
  $resp = & curl.exe -s -X POST -H 'Content-Type: application/json' --data-binary "@$fixture" http://localhost:4000/webhook
  Write-Host "  engine replied: $resp"
  if (($resp | ConvertFrom-Json).accepted -contains 'machine-1') { Pass 'webhook accepted machine-1' } else { Fail 'webhook did not accept machine-1' }
} else {
  Step 'Injecting memory fault on machine-1'
  Invoke-RestMethod -Method Post http://localhost:3001/fault/memory | Out-Null
  $ram = Wait-Until 'RAM > 85%' 30 {
    $m = (Invoke-WebRequest -UseBasicParsing http://localhost:3001/metrics).Content
    if ($m -match 'node_ram_usage_percent\{[^}]*\}\s+([0-9.]+)') { $v = [double]$matches[1]; if ($v -gt 85) { $v } }
  }
  Pass ("machine-1 RAM at {0:N1}%" -f $ram)

  Step 'Waiting for SustainedHighRAM to fire in Prometheus (~60-70s)'
  Wait-Until 'alert firing' 150 {
    $alerts = (Invoke-RestMethod http://localhost:9090/api/v1/alerts).data.alerts
    $alerts | Where-Object { $_.labels.alertname -eq 'SustainedHighRAM' -and $_.labels.machine_id -eq 'machine-1' -and $_.state -eq 'firing' }
  } | Out-Null
  Pass ("alert firing after {0:N0}s" -f ((Get-Date) - $t0).TotalSeconds)
}

Step 'During the reboot'
$code = Wait-Until 'gpu-render 503' 30 { $c = Get-Status http://localhost:8080/api/gpu-render 'application/json'; if ($c -eq 503) { $c } }
$headers = & curl.exe -s -D - -o NUL -H 'Accept: application/json' http://localhost:8080/api/gpu-render
if ($code -eq 503 -and ($headers -match 'Retry-After')) { Pass '/api/gpu-render -> 503 with Retry-After' } else { Fail "/api/gpu-render -> $code" }

$served = @()
for ($i = 0; $i -lt 6; $i++) {
  try { $served += (Invoke-RestMethod http://localhost:8080/api/shared).machineId } catch { $served += 'ERROR' }
}
if ($served -contains 'ERROR') { Fail "/api/shared dropped a request: $($served -join ', ')" }
else { Pass "/api/shared x6 all 200: $($served -join ', ')" }

Step 'Waiting for remediation to finish'
$entry = Wait-Until 'new history entry' 150 {
  $s = Invoke-RestMethod http://localhost:4000/status
  if ($s.history.Count -gt $before -and $s.inFlight.Count -eq 0) { $s.history[0] }
}
if ($entry.result -eq 'success') {
  Pass ("remediation success, MTTR {0:N1}s, vitalsRecovered={1}, lbSynced={2}" -f $entry.durationSeconds, $entry.vitalsRecovered, $entry.lbSynced)
} else {
  Fail "remediation result: $($entry.result) $($entry.error)"
}

Step 'After recovery'
$code = Wait-Until 'gpu-render 200' 30 { $c = Get-Status http://localhost:8080/api/gpu-render; if ($c -eq 200) { $c } }
if ($code -eq 200) { Pass '/api/gpu-render -> 200' } else { Fail "/api/gpu-render -> $code" }
$m1 = (Invoke-RestMethod http://localhost:8080/cluster-status).machines.'machine-1'
if ($m1.status -eq 'ONLINE') { Pass 'cluster-status: machine-1 ONLINE' } else { Fail "cluster-status: machine-1 is $($m1.status)" }

Write-Host ''
if ($failures -eq 0) { Write-Host 'E2E PASSED' -ForegroundColor Green; exit 0 }
Write-Host "E2E FAILED ($failures check(s))" -ForegroundColor Red
exit 1
