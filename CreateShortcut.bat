@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ── Find the packaged exe (release build preferred, dist as fallback) ──────────
set "EXE="
if exist "%~dp0release\win-unpacked\TradeAnalyzer.exe" (
    set "EXE=%~dp0release\win-unpacked\TradeAnalyzer.exe"
    set "WORKDIR=%~dp0release\win-unpacked"
) else if exist "%~dp0dist\win-unpacked\trade-analyzer.exe" (
    set "EXE=%~dp0dist\win-unpacked\trade-analyzer.exe"
    set "WORKDIR=%~dp0dist\win-unpacked"
) else (
    echo [ERROR] No packaged exe found. Run "npm run package" or "npm run build" first.
    pause
    exit /b 1
)

:: ── Create shortcut using COM (handles OneDrive-redirected Desktop correctly) ──
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = $ws.SpecialFolders('Desktop'); $sc = $ws.CreateShortcut(\"$desktop\TradeAnalyzer.lnk\"); $sc.TargetPath = '%EXE%'; $sc.WorkingDirectory = '%WORKDIR%'; $sc.Description = 'TradeAnalyzer - Options Trading Platform'; $sc.Save(); Write-Host \"Shortcut created: $desktop\TradeAnalyzer.lnk\""

echo.
echo  Points to: %EXE%
echo.
echo  Tip — to launch at Windows startup, copy the shortcut to:
echo    shell:startup   (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup)
echo.
pause
