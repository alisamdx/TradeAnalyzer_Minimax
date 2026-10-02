# QC-701 acceptances, 2026-09-28. SEC's companyfacts omitted these 10-Qs (filed 2026-07-28..31);
# the weekly retry keeps trying and QC-704 tracks each filing. Run from a NORMAL PowerShell window
# with both TradeAnalyzer apps closed:
#   powershell -ExecutionPolicy Bypass -File scripts\rulings-2026-09-28-qc701.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run rebuild:node | Out-Null

function Rule([string[]]$a) {
  Write-Host ">> exception.mjs $($a -join ' ')" -ForegroundColor Cyan
  & node packages/core/scripts/exception.mjs @a
  if ($LASTEXITCODE -ne 0) { throw "failed: $($a -join ' ')" }
}

$until = '2026-10-28'
$why = "SEC companyfacts omitted the July 10-Q (most filed 07-28/29 are missing; KO still absent live 09-28); weekly retry continues, QC-704 tracks the filing"
Rule @('accept', '9732',  "IQV: $why", $until)
Rule @('accept', '9733',  "JCI: $why", $until)
Rule @('accept', '14066', "LNT: $why", $until)
Rule @('accept', '14150', "HCA: $why", $until)
Rule @('accept', '14151', "HUM: $why", $until)
Rule @('accept', '14153', "KNX: $why", $until)
Rule @('accept', '14152', "KO: $why", $until)

Write-Host "All 7 accepted until $until." -ForegroundColor Green
