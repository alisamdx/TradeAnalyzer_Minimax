# QC-210 rulings, 2026-09-26. Run from a NORMAL PowerShell window (not from inside the
# Claude app) with both TradeAnalyzer apps closed:
#   powershell -ExecutionPolicy Bypass -File scripts\rulings-2026-09-26-qc210.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run rebuild:node | Out-Null

function Rule([string[]]$a) {
  Write-Host ">> exception.mjs $($a -join ' ')" -ForegroundColor Cyan
  & node packages/core/scripts/exception.mjs @a
  if ($LASTEXITCODE -ne 0) { throw "failed: $($a -join ' ')" }
}

# Same issuer, new share line: list_date moved but the company did not (v1.1.280 continuous-listing ruling).
Rule @('resolve','12963','false_positive','Same issuer, new share line: Ascendis ADS became ordinary shares 2026-04-20 (1:1), price continuous across the date')
Rule @('resolve','12966','false_positive','Same issuer: Columbia Banking System (CIK 887343) was the legal acquirer in the 2023-03-01 Umpqua merger and kept COLB; no price step at the date')
Rule @('resolve','12968','false_positive','Same issuer, new share line: James Hardie moved its primary listing to NYSE 2025-07-01 (ADR to ordinary, 1:1, same CIK 1159152 with facts from 2021); volume regime is the listing move and AZEK deal')

# A different issuer took the ticker.
Rule @('reuse','12964','BAM','2022-12-12','Spin-off: the old parent Brookfield Asset Management Inc became Brookfield Corp (BN); BAM passed to the new Brookfield Asset Management Ltd (CIK 1937926)')

Write-Host "All 4 rulings applied." -ForegroundColor Green
