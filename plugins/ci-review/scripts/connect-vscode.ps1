param(
  [int]$Port = 0
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-CiReview($p) {
  try {
    $ping = Invoke-RestMethod -Uri "http://127.0.0.1:$p/dsh-ci-review/api/bridge/ping" -TimeoutSec 1
    return $ping.ok -eq $true
  } catch {
    return $false
  }
}

if ($Port -gt 0) {
  $ports = @($Port)
} else {
  $ports = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 |
    Select-Object -ExpandProperty LocalPort -Unique |
    Where-Object { $_ -ge 3000 } |
    Sort-Object
}

foreach ($p in $ports) {
  if (-not (Test-CiReview $p)) { continue }
  try {
    $pair = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$p/dsh-ci-review/api/bridge/pair" -TimeoutSec 3
    if ($pair.ok -and $pair.token) {
      $port = if ($pair.port) { $pair.port } else { $p }
      $url = "vscode://local.ci-review-bridge/connect?port=$port&token=$([uri]::EscapeDataString($pair.token))"
      Start-Process $url
      Write-Host "ci-review: paired with DSH on port $port and asked VS Code to connect."
      exit 0
    }
  } catch {
    continue
  }
}

Write-Error "ci-review: no running DSH ci-review plugin found on loopback ports."
Write-Host "Start DSH, open the CI review panel once, then run this script again."
exit 1
