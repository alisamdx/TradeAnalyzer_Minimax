<#
.SYNOPSIS
  Spot-check the live v2 execution engine state via the control API (127.0.0.1:7433).

.DESCRIPTION
  Reads ~/.tradeanalyzer/agent.token and GETs /exec/state, then prints the fields that matter for
  an unattended paper day with a PASS/WARN read on each: broker (mock vs ibkr), engine-state,
  automation_mode/armed, broker-connected, and health. The control API is wired into boot as of
  v1.1.61 - a fresh launch of the packaged build is required for it to answer (see run-ibkr.ps1).

.EXAMPLE
  .\exec-state.ps1            # one-shot readout with interpretation
  .\exec-state.ps1 -Raw       # also dump the full JSON object
  .\exec-state.ps1 -Watch     # refresh every 5s until Ctrl+C (e.g. to watch stale_cycle clear)
  .\exec-state.ps1 -Watch -IntervalSec 10
#>
[CmdletBinding()]
param(
  [switch] $Raw,                 # also print the full state object
  [switch] $Watch,              # poll on an interval until Ctrl+C
  [int]    $IntervalSec = 5,     # -Watch interval
  [int]    $Port = 7433          # control API port
)

$ErrorActionPreference = 'Stop'

$tokenPath = Join-Path $HOME '.tradeanalyzer\agent.token'
if (-not (Test-Path $tokenPath)) {
  Write-Error "Agent token not found at '$tokenPath'. Launch the app at least once first."
  exit 1
}
$token = (Get-Content $tokenPath -Raw).Trim()
$uri = "http://127.0.0.1:$Port/exec/state"

function Write-Field {
  param([string] $Label, [string] $Value, [bool] $Ok, [string] $Note = '')
  if ($Ok) { $mark = 'PASS'; $color = 'Green' } else { $mark = 'WARN'; $color = 'Yellow' }
  $line = "  {0,-16} {1,-12} {2}" -f $Label, $Value, $mark
  if ($Note) { $line = $line + "  - " + $Note }
  Write-Host $line -ForegroundColor $color
}

function Show-State {
  try {
    $s = Invoke-RestMethod -Uri $uri -Headers @{ 'X-Agent-Token' = $token } -TimeoutSec 5
  } catch {
    Write-Host "Cannot reach the control API at $uri" -ForegroundColor Red
    Write-Host "  App not running, or an old build without the control API (relaunch via run-ibkr.ps1)." -ForegroundColor DarkGray
    return
  }

  Write-Host ("exec/state @ {0}" -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor Cyan

  Write-Field 'broker'        $s.broker          ($s.broker -eq 'ibkr')           'mock = not on IBKR (env var did not take)'
  Write-Field 'engineState'   $s.engineState     ($s.engineState -eq 'running')
  Write-Field 'automation'    $s.automationMode  ($s.automationMode -eq 'unattended') 'unattended=auto-entry; semi=approve-each; dry_run=decide only'
  Write-Field 'armed'         "$($s.armed)"      ([bool]$s.armed)                 'True = auto-entry active (running + unattended + paper)'
  Write-Field 'executionMode' $s.executionMode   ($s.executionMode -eq 'paper')   'auto-entry is paper-only'
  Write-Field 'brokerConn'    "$($s.health.brokerConnected)" ([bool]$s.health.brokerConnected) 'fail-closed-critical'

  $healthy = [bool]$s.health.healthy
  $reason  = $s.health.degradedReason
  if ($healthy) {
    Write-Field 'health' 'healthy' $true
  } elseif ($reason -eq 'stale_cycle') {
    Write-Field 'health' 'stale_cycle' $false 'benign right after Start; clears on the first ~120s cycle tick'
  } else {
    Write-Field 'health' "$reason" $false 'investigate'
  }

  if ([bool]$s.killSwitch.tripped) {
    Write-Field 'killSwitch' "TRIPPED ($($s.killSwitch.reason))" $false 'engine halted until cleared'
  }

  if ($Raw) {
    Write-Host ''
    $s | ConvertTo-Json -Depth 6
  }
}

if ($Watch) {
  Write-Host "Polling $uri every ${IntervalSec}s - Ctrl+C to stop." -ForegroundColor DarkGray
  while ($true) {
    Show-State
    Write-Host ''
    Start-Sleep -Seconds $IntervalSec
  }
} else {
  Show-State
}
