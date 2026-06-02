@echo off
REM Mock mode: test without GPU/llama.cpp. Simulates a provider.

title GPU Rental - Provider Agent (MOCK)

if not exist config.json (
    echo [ERROR] config.json not found. Run install.bat first.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   GPU Rental - Provider Agent (MOCK)
echo ============================================
echo.
echo No GPU or llama.cpp required.
echo This mode simulates a provider to test the platform.
echo.

call npm run mock

pause
