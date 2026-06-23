<#
.SYNOPSIS
  Launch the packaged TradeAnalyzer pointed at IBKR (TWS/Gateway) instead of the mock broker.

.DESCRIPTION
  The execution engine defaults to the deterministic MockExecutionBroker; IBKR is opt-in via the
  TA_EXEC_BROKER environment variable (see src/main/execution/broker-factory.ts). The app is also
  single-instance, so a still-running mock instance must be closed first or the relaunch just
  re-focuses it. This launcher does both: stops any running instance, sets the env var(s) for the
  child process, and starts the packaged exe.

  Paper vs live is read from exec_config.executionMode in the DB (NOT this script) — the engine
  resolves the TWS port from the mode (paper 7497 / live 7496). Use -Gateway for IB Gateway ports
  (paper 4002 / live 4001), or -Port to override explicitly.

  PREREQS on the TWS/Gateway side: API enabled (Global Config -> API -> Settings ->
  "Enable ActiveX and Socket Clients"), the matching socket port open, 127.0.0.1 trusted, and you
  logged in to the paper account.

.EXAMPLE
  .\run-ibkr.ps1
  # Stop mock instance, set TA_EXEC_BROKER=ibkr, launch. Expect: [execution] broker=ibkr mode=paper @ 127.0.0.1:7497

.EXAMPLE
  .\run-ibkr.ps1 -Gateway          # use IB Gateway ports (4002 paper)
  .\run-ibkr.ps1 -Port 7497        # force an explicit socket port
  .\run-ibkr.ps1 -ClientId 9       # use a specific TWS API client id
#>
[CmdletBinding()]
param(
  [switch] $Gateway,           # use IB Gateway ports instead of TWS
  [int]    $Port,              # explicit socket port override (TA_IBKR_PORT)
  [int]    $ClientId,          # TWS API client id (TA_IBKR_CLIENT_ID; default 7)
  [string] $ExePath            # override the exe path if yours lives elsewhere
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Resolve the packaged exe (default location from `npm run package`).
if (-not $ExePath) {
  $ExePath = Join-Path $root 'release\win-unpacked\TradeAnalyzer.exe'
}
if (-not (Test-Path $ExePath)) {
  Write-Error "TradeAnalyzer.exe not found at '$ExePath'. Run 'npm run package' first, or pass -ExePath."
  exit 1
}

# 1. Stop any running instance (single-instance lock would otherwise swallow the relaunch).
$running = Get-Process TradeAnalyzer -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Stopping $($running.Count) running TradeAnalyzer instance(s)..." -ForegroundColor Yellow
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 800   # let the single-instance lock release
}

# 2. Point the child process at IBKR.
$env:TA_EXEC_BROKER = 'ibkr'
if ($Gateway)  { $env:TA_IBKR_GATEWAY   = '1' } else { Remove-Item Env:\TA_IBKR_GATEWAY   -ErrorAction SilentlyContinue }
if ($Port)     { $env:TA_IBKR_PORT      = "$Port" } else { Remove-Item Env:\TA_IBKR_PORT      -ErrorAction SilentlyContinue }
if ($ClientId) { $env:TA_IBKR_CLIENT_ID = "$ClientId" } else { Remove-Item Env:\TA_IBKR_CLIENT_ID -ErrorAction SilentlyContinue }

Write-Host "Launching with TA_EXEC_BROKER=ibkr" -ForegroundColor Cyan
$portsNote = if ($Gateway) { 'IB Gateway (paper 4002 / live 4001)' } else { 'TWS (paper 7497 / live 7496)' }
Write-Host "  port source: $(if ($Port) { "explicit $Port" } else { $portsNote })"
Write-Host "  Watch the log for:  [execution] broker=ibkr mode=<paper|live> @ 127.0.0.1:<port>" -ForegroundColor Cyan
Write-Host "  If it says broker=mock, the env var did not reach the process (old instance still running?)." -ForegroundColor DarkGray

# 3. Launch. Inherits the env vars set above.
& $ExePath
