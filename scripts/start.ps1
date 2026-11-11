# puara-server - start the show stack on Windows: soundworks server + OSC
# bridge. The Windows twin of scripts/start.sh; keep the two in step.
#
# Run it through scripts\start.cmd, which starts it without changing the
# machine's PowerShell execution policy.
#
# Both run in this one window; Ctrl-C stops both. -Env defaults to `dev`
# (HTTPS, written by scripts\install.cmd) and falls back to `default` (plain
# HTTP, desktop testing only) when config\env-dev.yaml is absent.
#
# Usage:
#   scripts\start.cmd                  server + bridge
#   scripts\start.cmd -Env default     plain HTTP, no certificate
#   scripts\start.cmd -NoBridge        server only
#   scripts\start.cmd -Dump            also run oscdump on the first OSC port
#   scripts\start.cmd -ServeCa         only serve the mkcert root CA to phones
#
# ASCII only and Windows PowerShell 5.1 syntax - see install.ps1.

param(
  [Alias('Env')][string]$EnvName = '',
  [switch]$NoBridge,
  [switch]$Dump,
  [switch]$ServeCa
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CaPort = 8001

Set-Location $RepoRoot

function Info([string]$Message) { Write-Host $Message -ForegroundColor White }
function Warn([string]$Message) { Write-Host "! $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host $Message -ForegroundColor Red; exit 1 }

# skips Hyper-V/WSL, VM and VPN adapters; shared with the macOS/Linux scripts
function Get-LanIp {
  $Ip = "$(& node scripts/lan-ip.mjs)".Trim()
  if ($LASTEXITCODE -ne 0 -or -not $Ip) {
    return '127.0.0.1'
  }
  return $Ip
}

# ------------------------------------------------------- serve the root CA
# Plain HTTP on purpose: a phone that does not trust the CA yet cannot fetch it
# over a certificate signed by that same CA. Only the public certificate is
# exposed here, never the CA private key.
if ($ServeCa) {
  $OnPath = Get-Command mkcert -ErrorAction SilentlyContinue
  $Local = Join-Path $env:LOCALAPPDATA 'puara-server\bin\mkcert.exe'
  if ($OnPath) {
    $Mkcert = $OnPath.Source
  } elseif (Test-Path $Local) {
    $Mkcert = $Local
  } else {
    Fail 'mkcert not found - run scripts\install.cmd'
  }
  $CaRoot = "$(& $Mkcert -CAROOT)".Trim()
  $CaFile = Join-Path $CaRoot 'rootCA.pem'
  if (-not (Test-Path $CaFile)) {
    Fail "no rootCA.pem in $CaRoot"
  }
  $LanIp = Get-LanIp

  Info "Serving the mkcert root CA on http://${LanIp}:$CaPort/rootCA.crt"
  Write-Host '  Open that URL on the phone, install it, then trust it:'
  Write-Host '    iOS      profile install, THEN Settings > General > About >'
  Write-Host '             Certificate Trust Settings > enable'
  Write-Host '    Android  Settings > Security > Install a certificate > CA certificate'
  Write-Host ''
  Warn "This CA lets whoever holds $CaRoot\rootCA-key.pem impersonate any"
  Warn 'HTTPS site to that phone. Own test devices only; remove it afterwards.'
  Write-Host ''
  Write-Host '  Ctrl-C to stop serving (do that as soon as the phone is enrolled).'
  & node scripts/serve-ca.mjs $CaFile $LanIp $CaPort
  exit $LASTEXITCODE
}

# -------------------------------------------------------------- env pick
if (-not $EnvName) {
  if (Test-Path 'config\env-dev.yaml') {
    $EnvName = 'dev'
  } else {
    $EnvName = 'default'
    Warn 'no config\env-dev.yaml - falling back to plain HTTP.'
    Warn 'Phone sensors need HTTPS: run scripts\install.cmd to set it up.'
  }
}

if (-not (Test-Path "config\env-$EnvName.yaml")) {
  Fail "config\env-$EnvName.yaml not found"
}
if (-not (Test-Path '.build\server.js')) {
  Fail '.build\server.js missing - run npm run build (or scripts\install.cmd)'
}

# ---------------------------------------------------------- run, teardown
# The children share this console, so Ctrl-C reaches them directly; `finally`
# then stops whatever is still running, as start.sh's trap does.
$PreviousEnv = $env:ENV
$env:ENV = $EnvName
$Processes = @()
try {
  Info "Starting server (ENV=$EnvName)"
  $Processes += Start-Process -FilePath 'node' -ArgumentList '.build/server.js' -WorkingDirectory $RepoRoot -NoNewWindow -PassThru

  # The bridge is a soundworks client and needs the server up before it connects.
  Start-Sleep -Seconds 2

  if (-not $NoBridge) {
    Info 'Starting OSC bridge'
    $Processes += Start-Process -FilePath 'node' -ArgumentList '.build/clients/puara-bridge.js' -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
  }

  if ($Dump) {
    $OscDump = Get-Command oscdump -ErrorAction SilentlyContinue
    if (-not $OscDump) {
      Warn 'oscdump not found (it ships with liblo) - skipping -Dump'
    } else {
      $OscPort = "$(& node -e "import('./src/shared/load-puara-config.js').then(m => console.log(m.loadPuaraConfig().oscDestinations[0].port))")".Trim()
      if ($LASTEXITCODE -ne 0 -or -not $OscPort) {
        $OscPort = '9000'
      }
      Warn "oscdump binds UDP $OscPort exclusively - ossia score cannot also"
      Warn 'listen there. Add a second entry to oscDestinations for both at once.'
      Info "Starting oscdump on $OscPort"
      $Processes += Start-Process -FilePath $OscDump.Source -ArgumentList $OscPort -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
    }
  }

  Write-Host ''
  Info 'Running. Ctrl-C to stop everything.'
  while (@($Processes | Where-Object { -not $_.HasExited }).Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
} finally {
  foreach ($Process in $Processes) {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $env:ENV = $PreviousEnv
  Write-Host ''
  Info 'stopped'
}
