@echo off
REM Start the provider agent. Double-click after install.bat.

title GPU Rental - Provider Agent

if not exist config.json (
    echo [ERROR] config.json not found.
    echo Run install.bat first
    pause
    exit /b 1
)

if not exist node_modules (
    echo [ERROR] node_modules not found.
    echo Run install.bat first
    pause
    exit /b 1
)

echo.
echo ============================================
echo   GPU Rental - Provider Agent
echo ============================================
echo.
echo Ctrl+C for a clean shutdown
echo.

call npm start

echo.
echo Agent stopped.
pause
