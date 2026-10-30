<#
  Boots the multi-machine setup on one computer: the real server stack (server.compose.yml) plus
  5 simulated machines (sim.compose.yml), each a separate Docker daemon running its own machine-node.
  Stop the single-host cluster first (ports 8080/3000/... are shared):  docker compose down
    powershell -ExecutionPolicy Bypass -File deploy/multihost/simulate.ps1        # start
    powershell -ExecutionPolicy Bypass -File deploy/multihost/simulate.ps1 -Down  # remove
#>
param([switch]$Down)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$compose = @('compose', '--env-file', 'sim.env', '-f', 'server.compose.yml', '-f', 'sim.compose.yml')

if ($Down) { docker @compose down -v; exit $LASTEXITCODE }

docker build -q -t self-healing/machine-node:latest ../../machine-node | Out-Null
docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'compose up failed' }

$tar = Join-Path $env:TEMP 'self-healing-machine-node.tar'
docker save self-healing/machine-node:latest -o $tar

foreach ($n in 1..5) {
  $host_ = (docker @compose ps -q "host-$n").Trim()
  $deadline = (Get-Date).AddSeconds(90)
  while ($true) {
    docker exec $host_ docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw "host-$n Docker daemon did not start" }
    Start-Sleep -Seconds 2
  }
  docker cp $tar "${host_}:/tmp/machine-node.tar" | Out-Null
  docker exec $host_ docker load -q -i /tmp/machine-node.tar | Out-Null
  docker exec $host_ docker rm -f "machine-$n" *> $null
  # Same settings as node.compose.yml
  docker exec $host_ docker run -d --name "machine-$n" --restart unless-stopped `
    --memory 256m --memory-swap 256m -p 3000:3000 `
    -e "MACHINE_ID=machine-$n" -e PORT=3000 -e CONTAINER_MEM_LIMIT_MB=256 -e SIMULATE_GPU=true `
    -e "EXCLUSIVE_SERVICE=$(if ($n -eq 1) { 'true' } else { 'false' })" `
    self-healing/machine-node:latest | Out-Null
  Write-Host "machine-$n running on its own Docker host (host-$n)"
}
Remove-Item $tar

# The engine loads each host's TLS client certificate at startup; restart it now that all hosts generated theirs
docker @compose restart remediation-engine | Out-Null
Write-Host 'Multi-machine simulation is up: gateway http://localhost:8080, Grafana http://localhost:3000'
