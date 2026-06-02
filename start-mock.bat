@echo off
REM provider-agent/start-mock.bat
REM Mode mock pour tester sans GPU/llama.cpp. Simule un fournisseur.

title GPU Rental - Provider Agent (MOCK)

if not exist config.json (
    echo [ERREUR] config.json introuvable. Lance install.bat d'abord.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   GPU Rental - Provider Agent (MOCK)
echo ============================================
echo.
echo Aucun GPU/llama.cpp necessaire.
echo Ce mode simule un fournisseur pour tester la plateforme.
echo.

call npm run mock

pause
