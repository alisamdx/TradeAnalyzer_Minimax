@echo off
chcp 65001 >nul
title TradeAnalyzer - Stopping...
cd /d "%~dp0"

echo ==========================================
echo    TradeAnalyzer - Stopping Server
echo ==========================================
echo.

echo [1/3] Stopping Electron processes...
taskkill /F /IM "electron.exe" 2>nul
if errorlevel 1 (
    echo        No Electron processes found
) else (
    echo        Electron processes stopped
)

echo [2/3] Stopping Node.js processes...
taskkill /F /IM "node.exe" 2>nul
if errorlevel 1 (
    echo        No Node.js processes found
) else (
    echo        Node.js processes stopped
)

echo [3/3] Stopping Vite dev server...
taskkill /F /FI "WINDOWTITLE eq *Vite*" 2>nul
taskkill /F /FI "WINDOWTITLE eq *electron-vite*" 2>nul

:: Also check for any processes using port 5173 or 5174
echo        Checking for processes on ports 5173, 5174...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a 2>nul
    echo        Stopped process on port 5173 (PID: %%a)
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5174" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a 2>nul
    echo        Stopped process on port 5174 (PID: %%a)
)

echo.
echo ==========================================
echo    All components stopped!
echo ==========================================
echo.
pause
