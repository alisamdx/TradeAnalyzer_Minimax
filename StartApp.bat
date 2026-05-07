@echo off
chcp 65001 >nul
title TradeAnalyzer - Starting...
cd /d "%~dp0"

echo ==========================================
echo    TradeAnalyzer - Development Server
echo ==========================================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [1/4] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
) else (
    echo [1/4] Dependencies already installed... SKIP
)

:: Rebuild better-sqlite3 for Electron
echo [2/4] Rebuilding native modules for Electron...
call npm run rebuild:electron
if errorlevel 1 (
    echo [ERROR] Failed to rebuild native modules
    pause
    exit /b 1
)

:: Run type check
echo [3/4] Running type check...
call npx tsc --noEmit -p tsconfig.node.json
if errorlevel 1 (
    echo [WARNING] TypeScript errors found in main process, continuing...
)

echo [4/4] Starting Electron app...
echo.
echo ==========================================
echo    TradeAnalyzer is starting...
echo    Press Ctrl+C to stop
echo ==========================================
echo.

:: Set environment and start
cmd /c "set ELECTRON_RUN_AS_NODE=&& electron-vite dev"

if errorlevel 1 (
    echo.
    echo [ERROR] App failed to start
    pause
    exit /b 1
)

echo.
echo App stopped.
pause
