@echo off
REM One-click installer. Double-click is enough.
REM Auto-detects environment, configures config.json, guides auth.

setlocal enabledelayedexpansion
title GPU Rental - Provider Agent Installer

echo.
echo ============================================
echo   GPU Rental - Provider Agent Installer
echo ============================================
echo.

REM === Check Node.js ===
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo.
    echo Download and install Node.js 20 LTS:
    echo   https://nodejs.org/
    echo.
    echo Then double-click install.bat again
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo [OK] Node.js: !NODE_VERSION!

REM === Check nvidia-smi ===
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [WARN] nvidia-smi not found.
    echo        Auto-setup will fail without NVIDIA drivers.
    echo        Install drivers: https://nvidia.com/drivers
    echo.
    set /p continue="Continue anyway? (y/N): "
    if /i not "!continue!"=="y" exit /b 1
)

REM === cloudflared optional (debug only) ===
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo [INFO] cloudflared not installed — OPTIONAL, the agent works without it.
    echo        Download if you want to test llama via a public URL:
    echo        https://github.com/cloudflare/cloudflared/releases/latest
    echo.
) else (
    echo [OK] cloudflared detected (public debug tunnel)
)

REM === Node dependencies ===
if not exist node_modules (
    echo.
    echo === Installing Node dependencies ===
    echo (~1 minute the first time)
    echo.
    call npm install --silent
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

echo.
echo ============================================
echo   Auto-detection and configuration
echo ============================================
echo.
echo This script will:
echo   1. Detect your GPU automatically
echo   2. Detect llama-server in PATH
echo   3. Scan disk for .gguf models
echo   4. Ask for your Chia address (xch1...)
echo   5. Ask for the JWT from the frontend sign-in
echo.
pause

call npm run setup-auto
if errorlevel 1 (
    echo.
    echo [ERROR] Auto-setup failed.
    echo You can retry with: npm run setup-auto
    pause
    exit /b 1
)

echo.
echo ============================================
echo   All set!
echo ============================================
echo.
echo To start your agent:
echo   Double-click: start.bat
echo.
echo To change config:
echo   - Edit config.json (notepad)
echo   - OR use the frontend dashboard, click Edit on your GPU
echo   - OR run install.bat again
echo.
pause
