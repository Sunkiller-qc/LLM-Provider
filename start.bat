@echo off
REM provider-agent/start.bat
REM Lance l'agent fournisseur. Double-clic suffit apres install.bat.

title GPU Rental - Provider Agent

REM Verif config.json existe
if not exist config.json (
    echo [ERREUR] config.json introuvable.
    echo Lance d'abord install.bat
    pause
    exit /b 1
)

REM Verif node_modules
if not exist node_modules (
    echo [ERREUR] node_modules introuvable.
    echo Lance d'abord install.bat
    pause
    exit /b 1
)

echo.
echo ============================================
echo   GPU Rental - Provider Agent
echo ============================================
echo.
echo Ctrl+C pour arreter proprement
echo.

call npm start

echo.
echo Agent arrete.
pause
