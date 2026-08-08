<#
    Native installer for Windows.

        Right-click PowerShell -> Run as Administrator, then:
        powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1

    Installs Node.js and Caddy with winget, registers both as auto-starting
    scheduled tasks, opens the firewall, and prints the URL for the mod.
    Idempotent: re-run to upgrade in place without touching data.
#>

[CmdletBinding()]
param(
    [string]$Domain     = $env:DOMAIN,
    [string]$AcmeEmail  = $env:ACME_EMAIL,
    [string]$TlsMode    = $env:TLS_MODE,
    [int]   $AppPort    = 3000
)

$ErrorActionPreference = 'Stop'

$AppName   = 'palworld-rp-backend'
$Root      = Join-Path $env:ProgramData 'PalworldRPBackend'
$AppDir    = Join-Path $Root 'app'
$DataDir   = Join-Path $Root 'data'
$ConfDir   = Join-Path $Root 'config'
$LogDir    = Join-Path $Root 'logs'
$BackupDir = Join-Path $Root 'backups'
$EnvFile   = Join-Path $ConfDir 'env'
$CaddyFile = Join-Path $ConfDir 'Caddyfile'
$TaskApp   = 'PalworldRPBackend'
$TaskCaddy = 'PalworldRPBackendCaddy'

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "`n  error $m`n" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
Write-Step 'Preflight checks'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Die @'
This installer must run as Administrator.

Close this window, then: right-click PowerShell -> "Run as Administrator",
and run the command again. Administrator rights are needed to install
software, open the firewall, and register a service that starts at boot.
'@
}
Write-Ok 'Running as Administrator'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'server.js'))) {
    Die "Run this from inside the repository checkout (server.js not found next to deploy\)."
}
Write-Ok "Repository found at $RepoRoot"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die @'
winget is required and was not found.

It ships with Windows 11 and recent Windows 10. Install "App Installer" from
the Microsoft Store, then run this again.
'@
}
Write-Ok 'winget available'

# ---------------------------------------------------------------------------
Write-Step 'Working out how to serve HTTPS'

function Get-PublicIP {
    try { (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10).Trim() } catch { $null }
}
function Get-LocalIPs {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -ExpandProperty IPAddress
}
function Test-ResolvesTo($name, $want) {
    try {
        $r = Resolve-DnsName -Name $name -Type A -ErrorAction Stop |
             Where-Object { $_.IPAddress } | Select-Object -First 1
        return ($r -and $r.IPAddress -eq $want)
    } catch { return $false }
}

# Reuse whatever a previous run decided.
if (Test-Path $EnvFile) {
    $existing = Get-Content $EnvFile | Where-Object { $_ -match '^\s*[A-Z_]+=' }
    function Existing($k) {
        ($existing | Where-Object { $_ -like "$k=*" } | Select-Object -First 1) -replace "^$k=", ''
    }
    if (-not $Domain)    { $Domain    = Existing 'DOMAIN' }
    if (-not $AcmeEmail) { $AcmeEmail = Existing 'ACME_EMAIL' }
    if (-not $TlsMode)   { $TlsMode   = Existing 'TLS_MODE' }
    $AdminToken = Existing 'ADMIN_TOKEN'
    Write-Ok "Reusing configuration from $EnvFile"
}

$Site = $null
if ($Domain) {
    $Site = $Domain
    if (-not $TlsMode) { $TlsMode = 'letsencrypt' }
    Write-Ok "Using the domain you supplied: $Site"
} else {
    $publicIp = Get-PublicIP
    $localIps = @(Get-LocalIPs)

    if ($publicIp -and ($localIps -contains $publicIp)) {
        # Public address bound directly to this machine: a real server.
        $dashed = $publicIp -replace '\.', '-'
        foreach ($cand in @("$dashed.sslip.io", "$dashed.nip.io")) {
            if (Test-ResolvesTo $cand $publicIp) {
                $Site = $cand; $TlsMode = 'letsencrypt'
                Write-Ok "Publicly reachable; using $Site with a Let's Encrypt certificate"
                break
            }
        }
    }

    if (-not $Site) {
        # A desktop behind a router cannot complete an ACME challenge, so a
        # publicly-trusted certificate is not obtainable. Caddy issues its own
        # instead: still real TLS, just signed by a local authority.
        $lan = $localIps | Select-Object -First 1
        if (-not $lan) { Die 'Could not determine any usable IP address for this machine.' }
        $Site = $lan; $TlsMode = 'internal'
        if ($publicIp) { Write-Ok "Behind NAT (public $publicIp, local $lan)" }
        else           { Write-Ok "No public address detected; local install" }
        Write-Warn 'Using a locally-issued certificate. Real TLS, but not publicly trusted:'
        Write-Warn '  every player''s mod must be told to trust the exported CA file.'
    }
}

# ---------------------------------------------------------------------------
Write-Step 'Installing Node.js and Caddy'

function Ensure-Winget($id, $exe, $label) {
    if (Get-Command $exe -ErrorAction SilentlyContinue) { Write-Ok "$label already installed"; return }
    winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
    # winget updates PATH for new processes, not this one.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Die "$label installed but '$exe' is still not on PATH. Close this window, open a new Administrator PowerShell, and re-run."
    }
    Write-Ok "$label installed"
}

Ensure-Winget 'OpenJS.NodeJS.LTS' 'node'  'Node.js'
Ensure-Winget 'CaddyServer.Caddy' 'caddy' 'Caddy'

$nodeMajor = (& node -p 'process.versions.node.split(".")[0]')
if ([int]$nodeMajor -lt 20) { Die "Node $nodeMajor is too old; version 20 or newer is required." }
Write-Ok "Node $(& node -v)"

$NodeExe  = (Get-Command node).Source
$CaddyExe = (Get-Command caddy).Source

# ---------------------------------------------------------------------------
Write-Step "Installing application to $AppDir"

foreach ($d in @($Root, $AppDir, $DataDir, $ConfDir, $LogDir, $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

Get-ChildItem -Path $AppDir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem -Path $RepoRoot -Force |
    Where-Object { $_.Name -notin @('node_modules', 'data', '.env', '.git') } |
    Copy-Item -Destination $AppDir -Recurse -Force
Write-Ok 'Source installed'

Push-Location $AppDir
try {
    # npm-shrinkwrap.json is the lockfile npm ships inside a package;
    # package-lock.json is stripped from every pack. See install.sh for detail.
    if ((Test-Path 'npm-shrinkwrap.json') -or (Test-Path 'package-lock.json')) {
        & npm ci --omit=dev --no-audit --no-fund | Out-Null
    } else {
        Write-Warn 'No lockfile found, so dependency versions are resolved fresh.'
        Write-Warn 'For reproducible installs: npm install; npm shrinkwrap, then commit it.'
        & npm install --omit=dev --no-audit --no-fund | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { Die 'npm failed to install dependencies.' }
} finally { Pop-Location }
Write-Ok 'Dependencies installed'

# Lock the data directory down to SYSTEM and Administrators. Windows has no
# direct equivalent of the Unix service account used elsewhere; restricting the
# ACL is the closest meaningful protection for password hashes on disk.
$acl = Get-Acl $DataDir
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
foreach ($who in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $DataDir -AclObject $acl
Write-Ok 'Data directory restricted to SYSTEM and Administrators'

# ---------------------------------------------------------------------------
Write-Step "Writing $EnvFile"

if (-not $AdminToken) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $AdminToken = [Convert]::ToBase64String($bytes)
    $newToken = $true
}

@"
# Written by deploy\install-windows.ps1. Edit, then restart the task:
#   Restart-ScheduledTask -TaskName $TaskApp

DOMAIN=$Site
TLS_MODE=$TlsMode
ACME_EMAIL=$AcmeEmail
ADMIN_TOKEN=$AdminToken

HOST=127.0.0.1
PORT=$AppPort
DATA_DIR=$DataDir
TRUST_PROXY_HOPS=1
WARN_IF_INSECURE=false

REQUIRE_ENCRYPTION=true
SESSION_TTL_MINUTES=720
MIN_PASSWORD_LENGTH=8
MAX_PASSWORD_LENGTH=200
MAX_SESSIONS_PER_ACCOUNT=5
MAX_SOCKETS_PER_ACCOUNT=8
MAX_GUILDS_OWNED=3
MAX_ACCOUNTS=50000
MAX_MESSAGE_BYTES=100000
MAX_PROFILE_BYTES=262144
MAX_PROFILE_DEPTH=12
CHAT_BURST_BYTES=4000000
CHAT_REFILL_BYTES_PER_SEC=512000
CHAT_BURST_MESSAGES=20
CHAT_REFILL_MESSAGES_PER_SEC=4
SOCKET_QUERY_BURST=30
SOCKET_QUERY_REFILL_PER_SEC=5
LOCAL_CHAT_RADIUS=3000
POSITION_UPDATES_PER_SEC=5
MAX_PARTY_SIZE=8
MAX_CHANNELS_PER_ACCOUNT=10
MAX_MUTES_PER_ACCOUNT=500
REGISTER_PER_HOUR=5
LOGIN_PER_MINUTE=20
PROFILE_WRITES_PER_MINUTE=20
WRITES_PER_MINUTE=60
READS_PER_MINUTE=240
SEARCH_MAX_RESULTS=25
SEARCH_MIN_QUERY_LENGTH=1
LOG_LEVEL=info
CORS_ORIGIN=*
NODE_ENV=production
"@ | Set-Content -Path $EnvFile -Encoding UTF8

$acl = Get-Acl $EnvFile
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
foreach ($who in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $who, 'FullControl', 'None', 'None', 'Allow')))
}
Set-Acl -Path $EnvFile -AclObject $acl
Write-Ok 'Environment written and restricted (it holds the admin token)'

# ---------------------------------------------------------------------------
Write-Step "Configuring Caddy for $Site"

$template = Get-Content (Join-Path $AppDir 'deploy\Caddyfile.template') -Raw

if ($AcmeEmail) {
    $template = $template -replace '(?m)^# (BEGIN|END)_EMAIL\r?\n', ''
    $template = $template -replace '\{\{ACME_EMAIL\}\}', $AcmeEmail
} else {
    $template = [regex]::Replace($template, '(?s)# BEGIN_EMAIL.*?# END_EMAIL\r?\n', '')
}

if ($TlsMode -eq 'internal') {
    $tlsBlock = @"
	# Certificate issued by Caddy's own local authority. Still TLS with AES-256;
	# simply not signed by a public CA, because a machine behind a home router
	# cannot complete an ACME challenge.
	tls internal
"@
} else {
    $tlsBlock = @"
	# ``ciphers`` applies to TLS 1.2 only and pins it to AES-256-GCM. TLS 1.3
	# suite selection is not configurable in Go, and therefore not in Caddy.
	tls {
		protocols tls1.2 tls1.3
		ciphers TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
		curves x25519 secp384r1
	}
"@
}

$logPath = ($LogDir -replace '\\', '/') + '/caddy-access.log'
$template = $template -replace '\{\{TLS_BLOCK\}\}', $tlsBlock.Replace('$', '$$')
$template = $template -replace '\{\{SITE\}\}', $Site
$template = $template -replace '\{\{APP_PORT\}\}', $AppPort
$template = $template -replace '/var/log/caddy/access\.log', $logPath
$template | Set-Content -Path $CaddyFile -Encoding UTF8

& $CaddyExe validate --config $CaddyFile 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn 'Caddy rejected the explicit TLS block; retrying with Caddy defaults.'
    $stripped = [regex]::Replace((Get-Content $CaddyFile -Raw), '(?s)\ttls \{.*?\n\t\}\r?\n', '')
    $stripped | Set-Content -Path $CaddyFile -Encoding UTF8
    & $CaddyExe validate --config $CaddyFile 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "Generated Caddyfile failed validation. Inspect $CaddyFile." }
}
Write-Ok 'Caddyfile written and validated'

# ---------------------------------------------------------------------------
Write-Step 'Registering services'

# Windows has no systemd. A scheduled task running as SYSTEM at boot, with
# restart-on-failure, is the dependency-free equivalent — it needs no extra
# service-wrapper binary, which would otherwise be another thing to install and
# trust.
function Register-BootTask {
    param($Name, $Exe, $Arguments, $WorkDir)

    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

    $action    = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $WorkDir
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $Name
}

# The app needs its env file loaded; a small launcher does that, mirroring
# systemd's EnvironmentFile and launchd's wrapper on the other platforms.
$launcher = Join-Path $AppDir 'deploy\run-windows.cmd'
@"
@echo off
for /f "usebackq tokens=1,* delims==" %%A in ("$EnvFile") do (
  echo %%A| findstr /r "^#" >nul || if not "%%A"=="" set "%%A=%%B"
)
cd /d "$AppDir"
"$NodeExe" server.js >> "$LogDir\out.log" 2>> "$LogDir\err.log"
"@ | Set-Content -Path $launcher -Encoding ASCII

Register-BootTask -Name $TaskApp   -Exe 'cmd.exe' -Arguments "/c `"$launcher`"" -WorkDir $AppDir
Register-BootTask -Name $TaskCaddy -Exe $CaddyExe -Arguments "run --config `"$CaddyFile`"" -WorkDir $ConfDir
Write-Ok 'Both tasks registered and started (they run again at every boot)'

# ---------------------------------------------------------------------------
Write-Step 'Installing the palworld-rp command'

# A shim in System32 puts `palworld-rp` on PATH for every user, so npx is never
# needed again. It also sidesteps the npx quirk where a subcommand written after
# the package spec is read as the command name rather than an argument.
$shimDir = Join-Path $env:SystemRoot 'System32'
$shim = Join-Path $shimDir 'palworld-rp.cmd'
@"
@echo off
"$NodeExe" "$AppDir\bin\palworld-rp.js" %*
"@ | Set-Content -Path $shim -Encoding ASCII
Write-Ok "palworld-rp is now on your PATH (new shells only)"

# ---------------------------------------------------------------------------
Write-Step 'Firewall'

foreach ($p in @(80, 443)) {
    $rule = "PalworldRPBackend-$p"
    Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $p -Profile Any | Out-Null
}
Write-Ok 'Opened TCP 80 and 443'
Write-Warn "Port $AppPort is deliberately NOT opened: the app listens on 127.0.0.1 only."
if ($TlsMode -eq 'letsencrypt') {
    Write-Warn 'Your router must also forward 80 and 443 to this machine.'
}

# ---------------------------------------------------------------------------
Write-Step 'Waiting for the service'

$healthy = $false
foreach ($i in 1..30) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/health" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (-not $healthy) {
    Write-Host "`n  error Service did not become healthy. Recent log:" -ForegroundColor Red
    Get-Content (Join-Path $LogDir 'err.log') -Tail 30 -ErrorAction SilentlyContinue
    exit 1
}
Write-Ok 'Local health check passed'

if ($TlsMode -eq 'internal') {
    $caCandidates = @(
        "$env:ProgramData\Caddy\pki\authorities\local\root.crt",
        "$env:USERPROFILE\AppData\Roaming\Caddy\pki\authorities\local\root.crt",
        "$env:SystemRoot\System32\config\systemprofile\AppData\Roaming\Caddy\pki\authorities\local\root.crt"
    )
    $ca = $caCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($ca) {
        Copy-Item $ca (Join-Path $ConfDir 'local-ca.crt') -Force
        Write-Ok "Local CA exported to $ConfDir\local-ca.crt"
    } else {
        Write-Warn 'Could not locate Caddy''s root CA yet; it appears after the first HTTPS request.'
    }
}

"https://$Site" | Set-Content -Path (Join-Path $ConfDir 'backend-url.txt') -Encoding UTF8

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "  Installation complete" -ForegroundColor Green
Write-Host "================================================================`n" -ForegroundColor Cyan
Write-Host "  Paste this into the mod's Backend URL setting:`n" -ForegroundColor White
Write-Host "      https://$Site`n" -ForegroundColor Cyan

if ($TlsMode -eq 'internal') {
    Write-Host "  This install uses a locally-issued certificate. Every player's mod"
    Write-Host "  must trust $ConfDir\local-ca.crt or the connection is refused."
    Write-Host "  Ship that file alongside the mod. See ENCRYPTION.md.`n"
}
if ($newToken) {
    Write-Host "  Admin token (not shown again):" -ForegroundColor White
    Write-Host "      $AdminToken`n"
}

Write-Host @"
  Useful commands
    Restart-ScheduledTask -TaskName $TaskApp
    Stop-ScheduledTask    -TaskName $TaskApp
    Get-Content '$LogDir\out.log' -Tail 50 -Wait

  Layout
    code    $AppDir
    data    $DataDir
    config  $EnvFile
    logs    $LogDir

"@
