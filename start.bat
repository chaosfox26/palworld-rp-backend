@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === Palworld RP Backend ===

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not installed or not running.
  echo Install it from https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

docker compose version >nul 2>&1
if errorlevel 1 (
  echo Docker Compose v2 is required. Update Docker Desktop.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo Created .env from the example.
  echo Open it in Notepad and set ADMIN_TOKEN ^(and DOMAIN/ACME_EMAIL for HTTPS^),
  echo then run this file again.
  echo.
  pause
  exit /b 0
)

set "DOMAIN="
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="DOMAIN" set "DOMAIN=%%B"
)

if not "!DOMAIN!"=="" if not "!DOMAIN!"=="rp.example.com" (
  echo Starting with HTTPS for !DOMAIN! ...
  docker compose --profile tls up -d --build
  echo.
  echo Backend URL for the mod:  https://!DOMAIN!
) else (
  echo No DOMAIN set - starting in plain HTTP mode on port 3000 ^(loopback only^).
  echo This is fine for local testing. Do NOT expose it to the internet this way:
  echo passwords and chat would travel unencrypted.
  docker compose up -d --build backend
  echo.
  echo Backend URL for the mod:  http://127.0.0.1:3000
)

echo.
docker compose ps
echo.
echo Logs:  docker compose logs -f backend
echo Stop:  docker compose down
echo Data lives in the 'rp-data' Docker volume and survives rebuilds.
pause
