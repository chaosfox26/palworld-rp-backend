<#
    One-command installer for Windows.

    In an Administrator PowerShell:

        irm https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.ps1 | iex

    Installs git if needed, fetches the repository, and runs the full installer.
    Safe to re-run; it updates in place and never touches your data.
#>

[CmdletBinding()]
param(
    [string]$Repo   = $env:REPO_URL,
    [string]$Branch = $(if ($env:BRANCH) { $env:BRANCH } else { 'main' }),
    [string]$SrcDir = $(if ($env:SRC_DIR) { $env:SRC_DIR } else { Join-Path $env:ProgramData 'PalworldRPBackend\src' })
)

$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = 'https://github.com/chaosfox26/palworld-rp-backend.git' }

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "`n  error $m`n" -ForegroundColor Red; exit 1 }

Write-Host "`n  Palworld RP Backend - installer" -ForegroundColor White

# ---------------------------------------------------------------------------
# Administrator check.
#
# Unlike the Unix bootstrap, this cannot silently re-launch itself elevated:
# UAC opens a *new* window, so the user would watch this one exit and have no
# idea where the install went. Better to say so plainly.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Die @'
This needs to run as Administrator.

  1. Press Start, type "PowerShell"
  2. Right-click "Windows PowerShell" -> Run as Administrator
  3. Paste the same command again

Administrator rights are needed to install software, open the firewall, and
register a service that starts with Windows.
'@
}
Write-Ok 'Running as Administrator'

# Forks: pass -Repo https://github.com/you/your-fork.git to install from
# somewhere else. The default above points at the upstream repository.

# ---------------------------------------------------------------------------
Write-Step 'Checking prerequisites'

$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Major -lt 10) { Write-Warn "Windows $($osVersion.Major) is older than this targets; continuing anyway." }
else { Write-Ok "Windows $($osVersion.Major) build $($osVersion.Build)" }

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die @'
winget is required and was not found.

It ships with Windows 11 and recent Windows 10. Install "App Installer" from
the Microsoft Store, then run this again.
'@
}
Write-Ok 'winget available'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing git'
    winget install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Die 'git installed but is not on PATH yet. Close this window, open a new Administrator PowerShell, and run the command again.'
    }
    Write-Ok 'git installed'
} else {
    Write-Ok 'git already present'
}

# ---------------------------------------------------------------------------
Write-Step "Fetching $Repo ($Branch)"

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SrcDir) | Out-Null

if (Test-Path (Join-Path $SrcDir '.git')) {
    & git -C $SrcDir remote set-url origin $Repo
    & git -C $SrcDir fetch --quiet --depth 1 origin $Branch
    & git -C $SrcDir checkout --quiet -B $Branch "origin/$Branch"
    & git -C $SrcDir reset --hard --quiet "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { Die 'Failed to update the existing checkout.' }
    Write-Ok "Updated existing checkout at $SrcDir"
} else {
    Remove-Item -Recurse -Force $SrcDir -ErrorAction SilentlyContinue
    & git clone --quiet --depth 1 --branch $Branch $Repo $SrcDir
    if ($LASTEXITCODE -ne 0) { Die "Clone failed. Is the repository public, and is the URL correct?`n  Tried: $Repo (branch $Branch)" }
    Write-Ok "Cloned to $SrcDir"
}

$installer = Join-Path $SrcDir 'deploy\install-windows.ps1'
if (-not (Test-Path $installer)) { Die 'That repository does not contain deploy\install-windows.ps1 - wrong URL or branch?' }

# ---------------------------------------------------------------------------
Write-Step 'Running the installer'
& $installer
exit $LASTEXITCODE
