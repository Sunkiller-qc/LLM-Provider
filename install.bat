@echo off
REM provider-agent/install.bat
REM Installeur en un clic. Double-clic suffit.
REM Detecte tout automatiquement, configure config.json, guide l'auth.

setlocal enabledelayedexpansion
title GPU Rental - Provider Agent Installer

echo.
echo ============================================
echo   GPU Rental - Provider Agent Installer
echo ============================================
echo.

REM === Verif Node.js ===
where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe.
    echo.
    echo Telecharge et installe Node.js 20 LTS :
    echo   https://nodejs.org/
    echo.
    echo Puis double-clic sur install.bat
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo [OK] Node.js : !NODE_VERSION!

REM === Verif nvidia-smi ===
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [WARN] nvidia-smi introuvable.
    echo        L'auto-setup va planter sans drivers NVIDIA.
    echo        Installe les drivers : https://nvidia.com/drivers
    echo.
    set /p continue="Continuer quand meme ? (o/N) : "
    if /i not "!continue!"=="o" exit /b 1
)

REM === Cloudflared optionnel (pour debug uniquement) ===
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo [INFO] cloudflared non installe — c'est OPTIONNEL, l'agent marchera sans.
    echo        Telecharge si tu veux pouvoir tester ton llama via une URL publique :
    echo        https://github.com/cloudflare/cloudflared/releases/latest
    echo.
) else (
    echo [OK] cloudflared detecte (utilise pour tunnel public debug)
)

REM === Installation deps Node ===
if not exist node_modules (
    echo.
    echo === Installation des dependances Node ===
    echo (~1 minute la 1re fois)
    echo.
    call npm install --silent
    if errorlevel 1 (
        echo [ERREUR] npm install a echoue.
        pause
        exit /b 1
    )
    echo [OK] Dependances installees
)

echo.
echo ============================================
echo   Auto-detection et configuration
echo ============================================
echo.
echo Le script va :
echo   1. Detecter ton GPU et llama-server
echo   2. URL backend (defaut https://backend.chia-offer.com) + solo/pool
echo   3. Selectionner tes modeles (.bat ou .gguf)
echo   4. Si pool : SHA256 du GGUF (obligatoire, 1-2 min)
echo   5. Adresse Chia + JWT + benchmark + inscription
echo.
pause

call npm run setup-auto
if errorlevel 1 (
    echo.
    echo [ERREUR] L'auto-setup a echoue.
    echo Tu peux relancer avec : npm run setup-auto
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Tout est pret !
echo ============================================
echo.
echo Pour lancer ton agent :
echo   Double-clic sur : start.bat
echo.
echo Pour modifier ta config :
echo   - Edite config.json (notepad)
echo   - OU va sur ton dashboard frontend, clique "Modifier" sur ton GPU
echo   - OU relance : install.bat
echo.
pause
