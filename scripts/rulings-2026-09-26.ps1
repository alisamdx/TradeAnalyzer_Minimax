# QC-204/501 backlog rulings, 2026-09-26. Run from a NORMAL PowerShell window (not from
# inside the Claude app) with both TradeAnalyzer apps closed:
#   powershell -ExecutionPolicy Bypass -File scripts\rulings-2026-09-26.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run rebuild:node | Out-Null

function Rule([string[]]$a) {
  Write-Host ">> exception.mjs $($a -join ' ')" -ForegroundColor Cyan
  & node packages/core/scripts/exception.mjs @a
  if ($LASTEXITCODE -ne 0) { throw "failed: $($a -join ' ')" }
}

# A. Same issuer, genuine move - "not reuse" (QC-205/QC-209 false_positive); QC-204/501 close at the next gate.
Rule @('resolve','159','false_positive','Not reuse: GME May 2024 Roaring Kitty squeeze, same issuer')
Rule @('resolve','160','false_positive','Not reuse: GME May 2024 Roaring Kitty squeeze, same issuer')
Rule @('resolve','173','false_positive','Not reuse: WAL March 2023 regional bank crisis, same issuer')
Rule @('resolve','167','false_positive','Not reuse: SMMT Dec 2022 Akeso licensing deal, same issuer')
Rule @('resolve','153','false_positive','Not reuse: BMNR thin OTC prints (1-25 trades a day), same issuer')
Rule @('resolve','154','false_positive','Not reuse: BMNR ETH treasury pivot June-July 2025, same issuer')
Rule @('resolve','155','false_positive','Not reuse: BMNR ETH treasury pivot June-July 2025, same issuer')
Rule @('resolve','156','false_positive','Not reuse: BMNR ETH treasury pivot June-July 2025, same issuer')
Rule @('resolve','193','false_positive','Not reuse: Fiserv traded as FI mid-2023 to late 2025 and returned to FISV; same issuer, a hole not a splice')

# B. Ticker reuse - split membership at the step (deletes nothing).
Rule @('reuse','196','META','2022-06-09','Facebook took META from the Roundhill Metaverse ETF')
Rule @('reuse','190','COHR','2022-09-08','II-VI took COHR after acquiring Coherent Inc')
Rule @('reuse','194','HHH','2023-08-14','Howard Hughes Holdings took HHH from an earlier tiny listing')
Rule @('reuse','198','SAIL','2025-02-13','SailPoint Inc IPO; the earlier SAIL was the entity taken private in 2022')
Rule @('reuse','189','CAI','2025-06-18','Caris Life Sciences IPO; earlier CAI was CAI International')
Rule @('reuse','197','NIQ','2025-07-23','NIQ Global Intelligence IPO after a dormant earlier listing')
Rule @('reuse','192','FIG','2025-07-31','Figma IPO after an earlier occupant of FIG')
Rule @('reuse','188','BNY','2026-05-21','BNY Mellon took BNY from the BlackRock NY Muni trust')
Rule @('reuse','200','SPCX','2026-06-12','New listing took SPCX from the SPAC and New Issue ETF')
Rule @('reuse','191','ECHO','2026-06-24','EchoStar took ECHO; earlier ECHO was Echo Global Logistics, acquired Nov 2021')
Rule @('reuse','166','QXO','2024-07-30','Not a new issuer: an unrecorded ~5:1 split (close 60.50 to 12.05, ratio 0.199, narrow range, no Polygon split). Split here so 38 thin pre-split bars stop feeding indicators')

# C. Genuine moves under 90 days old - accept until they can close themselves.
Rule @('accept','98','MRNA 2026-08-19 genuine move (volume 3.4x); closes itself once 90 days old','2026-11-18')
Rule @('accept','100','NIQ 2026-08-11 genuine move (volume flat); closes itself once 90 days old','2026-11-18')

Write-Host "All 22 rulings applied." -ForegroundColor Green
