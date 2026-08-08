@echo off
setlocal EnableExtensions
title Palworld RP Backend - Installer

REM ===========================================================================
REM  Palworld RP Backend - one-file installer for Windows.
REM
REM  Double-click it. Nothing needs to be installed first: no Node, no npm,
REM  no npx, no git. They are installed for you if missing.
REM
REM  A .bat is used rather than a .ps1 because double-clicking a .ps1 opens it
REM  in Notepad by default, which is a poor first experience. This file simply
REM  elevates and hands over to PowerShell, which does the real work.
REM ===========================================================================

set "REPO_OWNER=chaosfox26"
set "REPO_NAME=palworld-rp-backend"
if "%BRANCH%"=="" set "BRANCH=main"
set "URL=https://raw.githubusercontent.com/%REPO_OWNER%/%REPO_NAME%/%BRANCH%/deploy/bootstrap.ps1"

echo.
echo   Palworld RP Backend - installer
echo   Nothing needs to be installed first.
echo.

REM --- Administrator check --------------------------------------------------
REM Installing a service, opening the firewall and installing software all
REM require elevation. `net session` fails for a standard user, which is the
REM most reliable check that works on every supported Windows version.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo   Administrator rights are required. Approving the UAC prompt will
    echo   reopen this installer in an elevated window.
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath '%~f0' -Verb RunAs" 2>nul
    if errorlevel 1 (
        echo.
        echo   Could not elevate. Right-click this file and choose
        echo   "Run as administrator" instead.
        echo.
        pause
    )
    exit /b
)

echo   Running with administrator rights.
echo.

REM --- Check PowerShell exists ----------------------------------------------
where powershell >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: PowerShell was not found on this system.
    echo   It ships with Windows 7 and later, so this is very unusual.
    echo.
    pause
    exit /b 1
)

REM --- Hand over ------------------------------------------------------------
REM -ExecutionPolicy Bypass applies to this process only. It does not change
REM the machine's policy, so nothing is loosened permanently.
REM
REM Tls12 is forced because older Windows builds default to TLS 1.0, which
REM github.com refuses. Without this the download fails with an unhelpful
REM "could not create SSL/TLS secure channel".
echo   Downloading and running the installer...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { $s = Invoke-RestMethod -UseBasicParsing '%URL%' } catch { Write-Host ''; Write-Host '  ERROR: Could not download the installer.' -ForegroundColor Red; Write-Host ('  Tried: %URL%'); Write-Host '  Check internet access and that the repository is public.'; exit 1 }; if ($s -notmatch '\S') { Write-Host '  ERROR: The download was empty.' -ForegroundColor Red; exit 1 }; Invoke-Expression $s"

set "RESULT=%errorlevel%"

echo.
if "%RESULT%"=="0" (
    echo   Done. Open a NEW terminal, then run:
    echo.
    echo       palworld-rp menu       to manage the server
    echo       palworld-rp doctor     to check every layer
    echo.
    echo   A new terminal is needed because PATH changes only apply to
    echo   processes started after the install.
) else (
    echo   The installer stopped with an error ^(exit %RESULT%^).
    echo   Scroll up for the reason. Re-running this file is safe.
)

echo.
pause
exit /b %RESULT%
