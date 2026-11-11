# puara-server - one-shot setup for a Windows workstation or show machine.
# The Windows twin of scripts/install.sh; keep the two in step.
#
# Run it through scripts\install.cmd, which starts it without changing the
# machine's PowerShell execution policy.
#
# Safe to rerun: every step checks its own result first and skips if already
# done. Nothing that already exists is overwritten - not the certificate, not
# config\env-dev.yaml. Delete the file yourself if you want it regenerated.
#
# No administrator rights needed. mkcert lands in %LOCALAPPDATA%\puara-server\bin.
#
# Usage: scripts\install.cmd [-NoHttps]
#
# Written for the Windows PowerShell 5.1 every Windows 10/11 ships, so: ASCII
# only (5.1 reads a BOM-less file as ANSI), no `&&`, `??` or ternaries, and
# native tools are never piped with 2>&1 (5.1 turns their stderr into errors).

param(
  [switch]$NoHttps
)

$ErrorActionPreference = 'Stop'

$MkcertVersion = 'v1.4.4'
# sha256 of each release binary (the release publishes none), taken from the
# release on 2026-11-11. Bump them with the version, together with install.sh.
$MkcertSha256 = @{
  'amd64' = 'd2660b50a9ed59eada480750561c96abc2ed4c9a38c6a24d93e30e0977631398'
  'arm64' = '793747256c562622d40127c8080df26add2fb44c50906ce9db63b42a5280582e'
}
$NodeMinMajor = 18

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CertDir = Join-Path $RepoRoot 'certs'
$EnvFile = Join-Path $RepoRoot 'config\env-dev.yaml'
$ToolsDir = Join-Path $env:LOCALAPPDATA 'puara-server\bin'
$AddonLog = Join-Path $env:TEMP 'puara-addon-build.log'
$BuildLog = Join-Path $env:TEMP 'puara-build.log'

function Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor White }
function Skip([string]$Message) { Write-Host "    . $Message" -ForegroundColor DarkGray }
function Ok([string]$Message) { Write-Host "    ok $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "    ! $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host $Message -ForegroundColor Red; exit 1 }

# Runs a command line through cmd.exe with all of its output in a log file:
# cmd does the redirection, so stderr stays plain text. Returns the exit code.
function Invoke-Logged([string]$CommandLine, [string]$Log) {
  cmd.exe /d /c "$CommandLine > `"$Log`" 2>&1"
  return $LASTEXITCODE
}

# Text for a single-quoted YAML scalar: forward slashes, which Node accepts on
# Windows, and doubled single quotes.
function ConvertTo-YamlPath([string]$Path) {
  return ($Path -replace '\\', '/') -replace "'", "''"
}

Set-Location $RepoRoot

# ---------------------------------------------------------------- node
Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail ("node not found. Install Node.js >= $NodeMinMajor (the LTS installer from nodejs.org, " +
    "or: winget install OpenJS.NodeJS.LTS), open a new terminal and rerun.")
}
$NodeVersion = (& node -v).Trim()
# no double quotes inside: 5.1 and 7 escape those differently for native tools
$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt $NodeMinMajor) {
  Fail "node $NodeVersion is too old - soundworks 5 needs >= $NodeMinMajor."
}
Ok "node $NodeVersion"

# ---------------------------------------------------------- dependencies
# `npm ci` installs exactly what package-lock.json pins, so every machine builds
# the tree that was tested. It replaces node_modules on each run, so stop a
# running server first: Windows will not delete files a process has open.
Step 'Installing npm dependencies'
& npm.cmd ci --no-fund --no-audit
if ($LASTEXITCODE -ne 0) {
  Fail 'npm ci failed. If it says EPERM or EBUSY, stop any running server and rerun.'
}
Ok 'node_modules ready'

# ------------------------------------------------------- LAN IP detection
# Skips Hyper-V/WSL, VirtualBox, VMware and VPN adapters - phones need the
# real interface address. Shared with the macOS/Linux scripts.
$LanIp = "$(& node scripts/lan-ip.mjs)".Trim()
if ($LASTEXITCODE -ne 0) {
  $LanIp = ''
}

# --------------------------------------------------------------- mkcert
$Mkcert = $null
if (-not $NoHttps) {
  Step 'Setting up mkcert (HTTPS for real phones)'

  $OnPath = Get-Command mkcert -ErrorAction SilentlyContinue
  $Local = Join-Path $ToolsDir 'mkcert.exe'
  if ($OnPath) {
    $Mkcert = $OnPath.Source
    Skip "mkcert already installed ($Mkcert)"
  } elseif (Test-Path $Local) {
    $Mkcert = $Local
    Skip "mkcert already installed ($Mkcert)"
  } else {
    $NodeArch = (& node -p 'process.arch').Trim()
    $Arch = @{ 'x64' = 'amd64'; 'arm64' = 'arm64' }[$NodeArch]
    if (-not $Arch) {
      Fail "no pinned mkcert build for windows-$NodeArch. Install mkcert yourself, or rerun with -NoHttps."
    }
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $Url = "https://github.com/FiloSottile/mkcert/releases/download/$MkcertVersion/mkcert-$MkcertVersion-windows-$Arch.exe"
    $Tmp = Join-Path $env:TEMP "puara-mkcert-$PID.exe"
    Write-Host "    downloading $MkcertVersion (windows-$Arch)..."
    # 5.1 defaults to TLS 1.0, which GitHub refuses; its progress bar also
    # slows the download to a crawl
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing
    $Got = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLower()
    if ($Got -ne $MkcertSha256[$Arch]) {
      Remove-Item -Force $Tmp
      Fail ("mkcert checksum mismatch - refusing to install.`n" +
        "  expected $($MkcertSha256[$Arch])`n  got      $Got")
    }
    Move-Item -Force -Path $Tmp -Destination $Local
    $Mkcert = $Local
    Ok "mkcert installed to $Mkcert"
  }

  # ------------------------------------------------------ certificate
  Step 'Issuing the LAN certificate'
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
  $Existing = Get-ChildItem -Path $CertDir -Filter '*.pem' |
    Where-Object { $_.Name -notlike '*-key.pem' } | Select-Object -First 1

  if ($Existing) {
    Skip "certificate already present: $($Existing.Name)"
    Skip 'delete certs\*.pem and rerun to reissue (phones keep trusting the same CA)'
    $CertFile = $Existing.FullName
  } elseif (-not $LanIp) {
    Warn 'no LAN IP detected - skipping certificate. Connect to a network and rerun.'
    $CertFile = ''
  } else {
    $HostName = [System.Net.Dns]::GetHostName().ToLower()
    Push-Location $CertDir
    try {
      & $Mkcert $LanIp "$HostName.local" $HostName localhost 127.0.0.1
    } finally {
      Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
      Fail 'mkcert could not issue the certificate.'
    }
    $Issued = Get-ChildItem -Path $CertDir -Filter '*.pem' |
      Where-Object { $_.Name -notlike '*-key.pem' } | Select-Object -First 1
    $CertFile = $Issued.FullName
    Ok "certificate issued for $LanIp"
  }

  # --------------------------------------------------- env-dev.yaml
  Step 'Writing config\env-dev.yaml'
  if (Test-Path $EnvFile) {
    Skip 'config\env-dev.yaml exists - left untouched'
  } elseif (-not $CertFile) {
    Warn 'no certificate, so no env-dev.yaml - rerun once you have a LAN IP'
  } else {
    $KeyFile = $CertFile -replace '\.pem$', '-key.pem'
    $Yaml = @(
      'type: development',
      'port: 8000',
      "serverAddress: '$LanIp'",
      'useHttps: true',
      'httpsInfos:',
      "  cert: '$(ConvertTo-YamlPath $CertFile)'",
      "  key: '$(ConvertTo-YamlPath $KeyFile)'",
      "baseUrl: ''",
      'auth:',
      '  clients: []',
      "  login: ''",
      "  password: ''"
    ) -join "`n"
    # WriteAllText: UTF-8 without the BOM that 5.1's Set-Content would add
    [System.IO.File]::WriteAllText($EnvFile, "$Yaml`n")
    Ok 'config\env-dev.yaml written (gitignored)'
  }
} else {
  Step 'Skipping HTTPS setup (-NoHttps)'
  Skip 'phones will have no motion sensors over plain HTTP - desktop testing only'
}

# ------------------------------------------------------- native addon
# The bridge runs the real C++ puara-gestures descriptors through a Node addon
# compiled against a checkout of that library. Optional - without it the
# audience system runs as usual, and the bridge says so at startup.
Step 'Building the puara-gestures addon'
if ($env:PUARA_GESTURES_PATH) {
  $GesturesPath = $env:PUARA_GESTURES_PATH
} else {
  $GesturesPath = Join-Path (Split-Path -Parent $RepoRoot) 'puara-gestures'
}

if (-not (Test-Path (Join-Path $GesturesPath 'include\puara\gestures.h'))) {
  Warn "puara-gestures not found at $GesturesPath"
  Skip 'clone it beside this repo, or set PUARA_GESTURES_PATH, and rerun'
  Skip 'the server still runs; there will be no /puara/gestures output'
} elseif (-not (Test-Path (Join-Path $GesturesPath '3rdparty\IMU_Sensor_Fusion\imu_orientation.cpp'))) {
  Warn "$GesturesPath is missing its 3rdparty submodule"
  Skip "run: git -C `"$GesturesPath`" submodule update --init --recursive"
} else {
  Ok "puara-gestures at $GesturesPath"
  $env:PUARA_GESTURES_PATH = $GesturesPath
  # node-gyp finds Visual Studio and Python itself; read its log for which is
  # missing rather than guessing beforehand
  $Code = Invoke-Logged 'npm.cmd run build:native' $AddonLog
  if ($Code -eq 0) {
    Ok 'addon built'
  } else {
    Warn "addon build failed - see $AddonLog"
    $LogText = Get-Content -Raw -Path $AddonLog
    if ($LogText -match 'find any Visual Studio') {
      Skip 'no C++ compiler: install Visual Studio Build Tools with "Desktop development with C++"'
      Skip '(or tick "Tools for Native Modules" when installing Node.js), then rerun'
    } elseif ($LogText -match 'find any Python') {
      Skip 'node-gyp needs Python 3: winget install Python.Python.3.12, then rerun'
    } elseif ($LogText -match 'namespace .puara_gestures.') {
      # the addon uses descriptors that are still open puara-gestures PRs
      Skip 'this checkout lacks descriptors the addon uses (open puara-gestures PRs)'
      Skip 'assemble them from Git Bash, then rerun:'
      Skip './scripts/combine-gestures-prs.sh --all --exclude 135 --build'
    }
    Skip 'the server still runs, without the C++ descriptors'
  }
}

# ---------------------------------------------------------------- build
Step 'Building'
$Code = Invoke-Logged 'npm.cmd run build' $BuildLog
if ($Code -ne 0) {
  Get-Content -Path $BuildLog -Tail 20 | ForEach-Object { Write-Host "    $_" }
  Fail "build failed - see $BuildLog"
}
Ok 'build complete'

# ------------------------------------------------------------- summary
Step 'Done'
Write-Host @"
    Start the server:   scripts\start.cmd
    Watch the C++ descriptors: the controller dashboard
    Desktop only:       scripts\start.cmd -Env default

    Windows Firewall asks about "Node.js" the first time the server starts:
    allow it on Private networks, and make sure this machine's Wi-Fi or
    Ethernet profile is Private, not Public, or phones cannot connect.

"@

if (-not $NoHttps -and $Mkcert) {
  $CaRoot = "$(& $Mkcert -CAROOT)".Trim()
  Write-Host @"
    Each test phone needs the mkcert root CA installed once, or wss:// fails
    silently and the sensors stay dark:

      CA file: $CaRoot\rootCA.pem
      Serve it to the phone: scripts\start.cmd -ServeCa

    iOS   install the profile, THEN Settings > General > About >
          Certificate Trust Settings > enable it (both steps required)
    Android  Settings > Security > Install a certificate > CA certificate

    Installing a CA lets whoever holds $CaRoot\rootCA-key.pem
    impersonate any HTTPS site to that phone. Keep that key on this machine,
    use your own test devices, and remove the CA from the phone when done.
    Audience devices should never install it - see docs/DEPLOYMENT.md tier 2.
"@
}
