# Run-28 leftovers, 2026-09-27. Run 28 (2026-09-22 17:05) collected nothing from E*Trade; run 30
# re-collected the date. Run from a NORMAL PowerShell window with both TradeAnalyzer apps closed:
#   powershell -ExecutionPolicy Bypass -File scripts\rulings-2026-09-27-run28.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run rebuild:node | Out-Null

function Rule([string[]]$a) {
  Write-Host ">> exception.mjs $($a -join ' ')" -ForegroundColor Cyan
  & node packages/core/scripts/exception.mjs @a
  if ($LASTEXITCODE -ne 0) { throw "failed: $($a -join ' ')" }
}

Rule @('resolve','13058','data_corrected','Run 28 got nothing from E*Trade; run 30 re-collected 2026-09-22 and stored expirations for all 599 subset tickers')
Rule @('resolve','14063','data_corrected','Run 28 got nothing from E*Trade; run 30 re-collected 2026-09-22 and stored the balance')
Rule @('resolve','14067','data_corrected','Run 28 got nothing from E*Trade; run 30 re-collected 2026-09-22 and stored the VIX quote')
Rule @('resolve','14064','false_positive','Run 28 returned no positions at all; the AMD 261016P520 put is held on every run from 09-21 to 09-25')

Write-Host "All 4 rulings applied." -ForegroundColor Green
