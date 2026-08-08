<#
  Palworld RP Backend - Windows one-liner.

      irm https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-windows.ps1 | iex

  Run it in an Administrator PowerShell. Installs the prerequisites (Node.js,
  which brings npm and npx), then runs the npx install.
#>

$ErrorActionPreference = 'Stop'

$RepoOwner = if ($env:REPO_OWNER) { $env:REPO_OWNER } else { 'chaosfox26' }
$RepoName  = if ($env:REPO_NAME)  { $env:REPO_NAME }  else { 'palworld-rp-backend' }
$Branch    = if ($env:BRANCH)     { $env:BRANCH }     else { 'main' }
$Spec      = "github:$RepoOwner/$RepoName#$Branch"

function Write-Step { param($m) Write-Host ""; Write-Host "==> $m" -ForegroundColor White }
function Write-Ok   { param($m) Write-Host "  ok   $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  warn $m" -ForegroundColor Yellow }
function Die        { param($m) Write-Host ""; Write-Host "  error $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "  Palworld RP Backend - Windows setup" -ForegroundColor White

# ---------------------------------------------------------------------------
Write-Step "Checking privileges"

# Installing software, opening the firewall and registering a boot task all
# require elevation. This is NOT auto-elevated: UAC opens a brand new window,
# so the install would carry on somewhere the user cannot see it.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die @"
This needs an Administrator PowerShell.

  Close this window. Click Start, type PowerShell, right-click
  'Windows PowerShell' and choose 'Run as administrator'. Then paste
  the same command again.
"@
}
Write-Ok "Running as Administrator"

# TLS 1.2. Older Windows builds still default to TLS 1.0, which github.com
# rejects, and the resulting error mentions SSL rather than the real cause.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
Write-Step "Installing Node.js (this is what provides npm and npx)"

function Update-PathFromRegistry {
    # winget updates the PATH stored in the registry, but the CURRENT process
    # keeps the environment it started with. Without re-reading it, `node` is
    # "not recognised" immediately after a successful install.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user | Where-Object { $_ }) -join ';'
}

function Get-NodeMajor {
    try {
        $v = (& node -v) 2>$null
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

$needNode = $true
$major = Get-NodeMajor
if ($major -ge 20) {
    $needNode = $false
    Write-Ok "Node $(& node -v) already installed"
} elseif ($major -gt 0) {
    Write-Warn "Node $(& node -v) is too old; installing a current one."
}

if ($needNode) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Die @"
winget was not found, so Node.js cannot be installed automatically.

  Install 'App Installer' from the Microsoft Store, then run this again.
  Or install Node.js manually from https://nodejs.org and re-run.
"@
    }

    Write-Host "  Installing OpenJS.NodeJS.LTS through winget. This takes a minute."
    & winget install --id OpenJS.NodeJS.LTS --exact --silent `
        --accept-package-agreements --accept-source-agreements | Out-Null

    Update-PathFromRegistry

    if ((Get-NodeMajor) -lt 20) {
        Die @"
Node.js was installed but is not usable in this window yet.

  PATH changes only apply to processes started afterwards. Close this
  window, open a NEW Administrator PowerShell, and paste the command
  again. It will skip straight past this step.
"@
    }
    Write-Ok "Node $(& node -v) installed"
}

# ---------------------------------------------------------------------------
Write-Step "Checking npm and npx"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm is missing even though Node is installed. Reinstall Node.js from https://nodejs.org."
}
Write-Ok "npm $(& npm -v)"

# The deprecated standalone npx package shadows the one built into npm and
# takes different arguments, producing "ERROR: You must supply a command".
try {
    $globals = (& npm ls -g --depth=0 2>$null) -join "`n"
    if ($globals -match '\snpx@') {
        Write-Warn "The deprecated standalone npx package is installed and would shadow npm's."
        & npm uninstall -g npx 2>$null | Out-Null
        Write-Ok "Removed it"
    }
} catch { }

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Die "npx is missing. Reinstall Node.js."
}
Write-Ok "npx present"

# ---------------------------------------------------------------------------
Write-Step "Installing Palworld RP Backend"
Write-Host "  Running: npx -y $Spec"

# Nothing after the spec. npm reads a trailing bare word as the name of the
# program to run, so `npx <spec> install` tries to launch a program called
# 'install'. The CLI installs by default when given no command.
& npx -y $Spec
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
    Write-Host "  Done. Open a NEW terminal, then run:" -ForegroundColor Green
    Write-Host ""
    Write-Host "      palworld-rp menu       to manage the server"
    Write-Host "      palworld-rp doctor     to check every layer"
    Write-Host ""
    Write-Host "  A new terminal is needed because PATH changes only apply to"
    Write-Host "  processes started after the install."
} else {
    Write-Host "  The installer stopped with an error (exit $code)." -ForegroundColor Red
    Write-Host "  Scroll up for the reason. Re-running this is safe."
}
exit $code
