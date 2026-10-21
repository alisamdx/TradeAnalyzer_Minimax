# Bull put spread vs CSP — wheel replay entries (prices to 2026-10-20, slip: quoted per ticker (0.5 × median half-spread, intraday quotes), fallback $0.03/leg)

Replay picks 1495 → unsettled 0, no bars 0, excluded as split 0 / ticker reuse 0, usable 1495 → **480 episodes** (1015 repeat entries collapsed). IV from rolling vol (no iv_history): 16.
Entry dates 2025-06-02 … 2026-08-10.

Genuine >35% moves KEPT in the sample (3): CGNX 2026-02-12 (36%); ORCL 2025-09-10 (36%); SNPS 2025-09-10 (-36%)

Quoted slippage (intraday quotes only): 276 tickers with ≥3 quotes — 276 from intraday, 0 from after-close. Rows read: briefCandidatesIntraday 1904, briefCandidatesAfterClose 2121, spreadChainsIntraday 81561, spreadChainsAfterClose 84145, premiumHistoryAfterClose 86076. Per leg: p10 $0.025 · median $0.175 · p90 $0.787. Entries priced from quotes: 1313 of 1495; the rest use the $0.03 fallback.
**08 §4 quoted-cost coverage: PASSES** — entries 88% (1313/1495), replay tickers 63% (113/179); both must be ≥ 50%.

ret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.

## 1. Draft profile — 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| episodes | 468 | 54.3 | -5.57 | 1.28 | **-0.549** | 10.2 | T56 S15 H29 E0 | 80.8 | 0.44 | 0.81 | **0.048** | 9.1 |
| pooled (every replay day) | 1447 | 52.9 | -6.09 | 1.21 | **-0.575** | 10.6 | T53 S14 H33 E0 | 80.5 | 0.39 | 0.81 | **0.041** | 9.5 |

Tails (episodes): spread p5 -48.6% / worst $-2824 per contract; CSP p5 -3.4% / worst $-11928. Avg P&L per contract: spread $-62, CSP $65.
Credit as % of width (5%-of-spot wing): p10 9 · p25 12 · median 15 · p75 18 · p90 21.
Round-trip cost (4 leg-fills) as % of mid credit: p10 10 · p25 21 · median 39 · p75 71 · p90 100.
IV rank at entry (episodes with a rank, 287): <30 2 · 30–50 1 · 50–80 47 · ≥80 237

## 2. Exit grid (30d Δ0.25 w5% skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts10 | 468 | 42.3 | -7.63 | -3.13 | **-1.120** | 6.8 | T37 S29 H34 E0 | 71.6 | 0.31 | 0.65 | **0.044** | 7.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts15 | 468 | 49.6 | -7.25 | -0.17 | **-0.887** | 8.2 | T50 S34 H17 E0 | 76.9 | 0.33 | 0.78 | **0.040** | 8.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts– | 468 | 55.6 | -7.49 | 2.60 | **-0.825** | 9.1 | T60 S40 H0 E1 | 79.9 | 0.27 | 0.87 | **0.030** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts10 | 468 | 43.6 | -6.29 | -2.33 | **-0.783** | 8.0 | T40 S11 H50 E0 | 72.6 | 0.39 | 0.65 | **0.052** | 7.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 468 | 54.3 | -5.57 | 1.28 | **-0.549** | 10.2 | T56 S15 H29 E0 | 80.8 | 0.44 | 0.81 | **0.048** | 9.1 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts– | 468 | 68.2 | -4.78 | 5.32 | **-0.390** | 12.3 | T76 S21 H0 E3 | 88.7 | 0.45 | 0.94 | **0.043** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts10 | 468 | 43.6 | -6.41 | -2.33 | **-0.739** | 8.7 | T40 S0 H60 E0 | 72.6 | 0.39 | 0.65 | **0.050** | 7.6 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts15 | 468 | 54.3 | -5.18 | 1.28 | **-0.456** | 11.4 | T57 S0 H43 E0 | 81.8 | 0.50 | 0.81 | **0.053** | 9.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 468 | 73.5 | -2.97 | 5.97 | **-0.190** | 15.6 | T85 S0 H0 E15 | 93.6 | 0.67 | 0.96 | **0.056** | 12.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts10 | 468 | 40.2 | -7.69 | -4.44 | **-0.979** | 7.9 | T19 S29 H52 E0 | 69.9 | 0.30 | 0.66 | **0.034** | 8.6 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts15 | 468 | 46.6 | -7.17 | -1.27 | **-0.717** | 10.0 | T35 S35 H30 E0 | 73.9 | 0.34 | 0.92 | **0.031** | 10.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts– | 468 | 54.5 | -7.15 | 3.94 | **-0.603** | 11.9 | T55 S43 H0 E1 | 76.3 | 0.36 | 1.19 | **0.028** | 12.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts10 | 468 | 41.5 | -6.28 | -3.02 | **-0.686** | 9.1 | T21 S11 H68 E0 | 70.9 | 0.37 | 0.66 | **0.041** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts15 | 468 | 51.3 | -5.33 | 0.69 | **-0.439** | 12.2 | T39 S15 H46 E0 | 77.8 | 0.46 | 0.96 | **0.039** | 11.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts– | 468 | 70.1 | -3.72 | 8.29 | **-0.237** | 15.7 | T71 S23 H0 E6 | 85.3 | 0.56 | 1.30 | **0.038** | 14.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts10 | 468 | 41.5 | -6.39 | -3.02 | **-0.654** | 9.8 | T21 S0 H79 E0 | 70.9 | 0.39 | 0.66 | **0.042** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts15 | 468 | 51.3 | -4.93 | 0.69 | **-0.369** | 13.4 | T40 S0 H60 E0 | 78.8 | 0.54 | 0.96 | **0.044** | 12.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts– | 468 | 78.0 | -1.18 | 8.93 | **-0.061** | 19.3 | T79 S0 H0 E21 | 90.6 | 0.83 | 1.31 | **0.050** | 16.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts10 | 468 | 40.2 | -7.59 | -4.41 | **-0.875** | 8.7 | T0 S29 H71 E0 | 69.7 | 0.32 | 0.65 | **0.032** | 10.0 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts15 | 468 | 45.1 | -7.16 | -2.16 | **-0.597** | 12.0 | T0 S35 H65 E0 | 72.0 | 0.36 | 0.90 | **0.026** | 14.2 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts– | 468 | 54.1 | -4.51 | 12.00 | **-0.219** | 20.6 | T0 S45 H0 E55 | 72.9 | 0.54 | 1.51 | **0.021** | 25.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts10 | 468 | 41.5 | -6.18 | -2.90 | **-0.619** | 10.0 | T0 S11 H89 E0 | 70.7 | 0.39 | 0.66 | **0.038** | 10.4 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts15 | 468 | 49.8 | -5.30 | -0.10 | **-0.372** | 14.2 | T0 S15 H85 E0 | 75.9 | 0.48 | 0.95 | **0.032** | 15.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts– | 468 | 72.0 | 0.33 | 15.62 | **0.013** | 25.9 | T0 S24 H0 E76 | 82.5 | 0.78 | 1.62 | **0.028** | 28.0 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts10 | 468 | 41.5 | -6.29 | -2.90 | **-0.592** | 10.6 | T0 S0 H100 E0 | 70.7 | 0.41 | 0.66 | **0.039** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts15 | 468 | 49.8 | -4.89 | -0.10 | **-0.316** | 15.5 | T0 S0 H100 E0 | 76.9 | 0.56 | 0.95 | **0.036** | 15.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts– | 468 | 84.4 | 3.95 | 15.94 | **0.132** | 30.0 | T0 S0 H0 E100 | 87.8 | 1.05 | 1.65 | **0.035** | 30.0 |

## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew0 pt0.5 sl2 ts15 | 469 | 58.0 | -4.96 | 2.35 | **-0.512** | 9.7 | T59 S14 H26 E0 | 80.4 | 0.37 | 0.77 | **0.043** | 8.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 468 | 54.3 | -5.57 | 1.28 | **-0.549** | 10.2 | T56 S15 H29 E0 | 80.8 | 0.44 | 0.81 | **0.048** | 9.1 |
| 30d Δ0.25 w5.0% skew6 pt0.5 sl2 ts15 | 465 | 48.8 | -6.20 | -0.21 | **-0.569** | 10.9 | T50 S15 H35 E0 | 82.4 | 0.49 | 0.86 | **0.051** | 9.6 |

## 4. Entry DTE × short delta (draft exits, w5%, skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 21d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 449 | 56.1 | -4.74 | 1.64 | **-0.620** | 7.6 | T70 S22 H8 E0 | 89.1 | 0.30 | 0.54 | **0.041** | 7.2 |
| 21d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 460 | 61.5 | -4.88 | 3.73 | **-0.574** | 8.5 | T69 S19 H12 E0 | 87.0 | 0.38 | 0.74 | **0.050** | 7.6 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 469 | 63.5 | -4.52 | 5.58 | **-0.488** | 9.3 | T67 S16 H17 E0 | 85.7 | 0.50 | 0.90 | **0.061** | 8.1 |
| 30d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 451 | 51.9 | -5.00 | 0.86 | **-0.532** | 9.4 | T58 S18 H24 E0 | 83.4 | 0.38 | 0.64 | **0.044** | 8.6 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 468 | 54.3 | -5.57 | 1.28 | **-0.549** | 10.2 | T56 S15 H29 E0 | 80.8 | 0.44 | 0.81 | **0.048** | 9.1 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 475 | 54.5 | -5.80 | 2.63 | **-0.536** | 10.8 | T53 S13 H34 E0 | 79.4 | 0.50 | 0.99 | **0.052** | 9.5 |
| 35d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 453 | 48.6 | -5.03 | -0.57 | **-0.498** | 10.1 | T52 S16 H32 E0 | 80.8 | 0.37 | 0.68 | **0.040** | 9.2 |
| 35d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 468 | 51.1 | -5.81 | 0.85 | **-0.536** | 10.8 | T50 S13 H37 E0 | 79.1 | 0.46 | 0.88 | **0.048** | 9.7 |
| 35d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 475 | 49.7 | -6.37 | -0.43 | **-0.552** | 11.5 | T47 S11 H43 E0 | 77.3 | 0.54 | 1.06 | **0.054** | 10.1 |

## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 468 | 73.5 | -2.97 | 5.97 | **-0.190** | 15.6 | T85 S0 H0 E15 | 93.6 | 0.67 | 0.96 | **0.056** | 12.0 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– | 475 | 80.2 | -0.28 | 6.48 | **-0.019** | 14.4 | T88 S0 H0 E12 | 93.1 | 0.66 | 0.95 | **0.055** | 12.0 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– | 479 | 83.9 | 1.03 | 6.13 | **0.075** | 13.7 | T89 S0 H0 E11 | 92.9 | 0.66 | 0.94 | **0.054** | 12.0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | 475 | 75.8 | -2.51 | 9.21 | **-0.151** | 16.6 | T81 S0 H0 E19 | 89.7 | 0.73 | 1.21 | **0.056** | 13.0 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– | 478 | 80.1 | 0.33 | 9.46 | **0.021** | 15.5 | T84 S0 H0 E16 | 89.5 | 0.73 | 1.21 | **0.056** | 13.0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | 479 | 82.9 | 1.57 | 8.65 | **0.107** | 14.7 | T85 S0 H0 E15 | 89.6 | 0.73 | 1.20 | **0.056** | 13.0 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– | 476 | 75.2 | -3.20 | 12.29 | **-0.182** | 17.5 | T76 S0 H0 E24 | 87.4 | 0.84 | 1.49 | **0.061** | 13.8 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– | 479 | 80.2 | 0.44 | 12.83 | **0.027** | 16.5 | T80 S0 H0 E20 | 87.3 | 0.85 | 1.48 | **0.061** | 13.8 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– | 479 | 82.7 | 1.95 | 11.21 | **0.125** | 15.6 | T81 S0 H0 E19 | 87.3 | 0.85 | 1.48 | **0.061** | 13.8 |

## 4c. Same grid, liquid entries only — round-trip cost (open + close, both legs) ≤ 25% of the mid credit

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 152 | 87.5 | 1.02 | 11.54 | **0.069** | 14.7 | T85 S0 H0 E15 | 92.1 | 0.58 | 1.10 | **0.048** | 12.2 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 202 | 91.1 | 2.91 | 9.53 | **0.218** | 13.3 | T89 S0 H0 E11 | 93.6 | 0.73 | 1.05 | **0.063** | 11.6 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 235 | 92.8 | 4.01 | 8.12 | **0.321** | 12.5 | T91 S0 H0 E9 | 94.0 | 0.80 | 1.08 | **0.070** | 11.5 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 188 | 85.6 | 3.01 | 14.86 | **0.196** | 15.3 | T84 S0 H0 E16 | 88.8 | 0.70 | 1.32 | **0.056** | 12.6 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 245 | 88.2 | 3.96 | 12.83 | **0.276** | 14.3 | T86 S0 H0 E14 | 89.8 | 0.88 | 1.35 | **0.071** | 12.4 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 280 | 88.2 | 4.02 | 10.78 | **0.291** | 13.8 | T86 S0 H0 E14 | 89.6 | 0.83 | 1.33 | **0.067** | 12.4 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 215 | 80.5 | 0.71 | 17.70 | **0.043** | 16.7 | T76 S0 H0 E24 | 86.5 | 0.78 | 1.49 | **0.058** | 13.5 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 281 | 85.1 | 3.53 | 15.07 | **0.228** | 15.5 | T81 S0 H0 E19 | 87.5 | 0.91 | 1.51 | **0.070** | 13.1 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 315 | 86.3 | 4.34 | 13.40 | **0.296** | 14.6 | T83 S0 H0 E17 | 87.6 | 0.91 | 1.57 | **0.070** | 13.1 |

## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| credit ≥ 20% of width | 61 | 65.6 | 0.13 | 12.52 | **0.012** | 10.8 | T61 S5 H34 E0 | 77.0 | 0.95 | 1.55 | **0.097** | 9.9 |
| credit < 20% of width | 407 | 52.6 | -6.43 | 1.01 | **-0.639** | 10.1 | T55 S16 H29 E0 | 81.3 | 0.37 | 0.77 | **0.040** | 9.0 |
| round-trip cost ≤ 25% of credit | 152 | 71.1 | 0.63 | 9.04 | **0.060** | 10.4 | T62 S8 H30 E0 | 80.3 | 0.48 | 0.95 | **0.052** | 9.3 |
| round-trip cost 25–50% of credit | 131 | 69.5 | -0.58 | 5.23 | **-0.057** | 10.1 | T63 S5 H32 E0 | 87.0 | 0.84 | 0.85 | **0.100** | 8.4 |
| round-trip cost > 50% of credit | 185 | 29.7 | -14.20 | -6.22 | **-1.421** | 10.0 | T46 S27 H27 E0 | 76.8 | 0.13 | 0.67 | **0.013** | 9.6 |
| IV rank ≥ 30 | 281 | 58.7 | -4.05 | 3.07 | **-0.416** | 9.8 | T59 S13 H28 E0 | 82.9 | 0.67 | 0.94 | **0.077** | 8.7 |
| IV rank < 30 | 2 | 0.0 | -27.36 | -19.72 | **-4.209** | 6.5 | T0 S100 H0 E0 | 0.0 | -2.00 | -1.34 | **-0.267** | 7.5 |
| IV rank unknown | 185 | 48.1 | -7.64 | -0.75 | **-0.707** | 10.8 | T51 S17 H32 E0 | 78.4 | 0.12 | 0.65 | **0.012** | 9.9 |
| close above SMA50 | 404 | 52.7 | -6.47 | 1.03 | **-0.639** | 10.1 | T55 S16 H29 E0 | 80.2 | 0.38 | 0.78 | **0.041** | 9.2 |
| close below SMA50 | 64 | 64.1 | 0.13 | 5.07 | **0.013** | 10.3 | T59 S6 H34 E0 | 84.4 | 0.86 | 0.89 | **0.096** | 8.9 |
| quoted slip ≤ $0.03/leg | 28 | 64.3 | 0.66 | 7.78 | **0.060** | 11.1 | T57 S7 H36 E0 | 92.9 | 0.72 | 0.89 | **0.081** | 9.0 |
| quoted slip > $0.03/leg | 341 | 47.8 | -7.99 | -0.72 | **-0.761** | 10.5 | T52 S17 H31 E0 | 79.5 | 0.34 | 0.74 | **0.035** | 9.6 |
| no quotes (fallback slip) | 99 | 73.7 | 0.98 | 8.01 | **0.113** | 8.7 | T68 S10 H22 E0 | 81.8 | 0.71 | 0.91 | **0.096** | 7.5 |

## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 2025-Q2 | 30 | 46.7 | -2.83 | -0.75 | **-0.222** | 12.7 | T57 S3 H40 E0 | 83.3 | 0.31 | 0.43 | **0.029** | 10.7 |
| 2025-Q3 | 113 | 47.8 | -10.81 | -1.05 | **-1.087** | 9.9 | T48 S24 H28 E0 | 74.3 | -0.15 | 0.65 | **-0.016** | 9.6 |
| 2025-Q4 | 95 | 58.9 | -2.16 | 1.91 | **-0.226** | 9.5 | T63 S9 H27 E0 | 88.4 | 0.85 | 0.91 | **0.102** | 8.3 |
| 2026-Q1 | 100 | 53.0 | -7.36 | 1.14 | **-0.755** | 9.8 | T56 S22 H22 E0 | 79.0 | 0.25 | 0.79 | **0.028** | 9.0 |
| 2026-Q2 | 84 | 61.9 | -2.28 | 3.95 | **-0.210** | 10.8 | T57 S6 H37 E0 | 82.1 | 0.91 | 1.12 | **0.099** | 9.3 |
| 2026-Q3 | 46 | 54.3 | -3.66 | 5.80 | **-0.371** | 9.9 | T57 S11 H33 E0 | 80.4 | 0.70 | 1.09 | **0.081** | 8.7 |

## 7. Portfolio — $25,000 pot, every replay day in pick-rank order, one position per ticker, ≤ 10 open
Spread sized to ≤ $2500 max loss per position; CSP to ≤ 25% of the pot in cash per position. P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, capital = no free cash, dup = ticker already open, full = position cap.

on deployed % = total P&L ÷ average capital in use. Gated rows (cost≤) filter BOTH columns to the same liquid entries.

| config | SPREAD final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full |
|---|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | $1,142 | **-95.4** | -91.9 | -391.2 | $23,885 (95.5%) | 212 | 24 | 81/688/388/78 | $29,058 | **16.2** | 13.0 | 40.5 | $302 (1.2%) | 114 | 40 | 1139/4/190/0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | $13,901 | **-44.4** | -37.0 | -62.4 | $16,305 (55.0%) | 277 | 71 | 60/102/430/578 | $29,630 | **18.5** | 14.3 | 41.2 | $370 (1.4%) | 101 | 45 | 1139/9/198/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $9,475 | **-62.1** | -53.4 | -89.2 | $20,569 (68.5%) | 250 | 70 | 50/121/402/644 | $31,167 | **24.7** | 18.9 | 51.4 | $370 (1.4%) | 101 | 48 | 1158/11/197/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | $41,354 | **65.4** | 48.6 | 94.0 | $6,351 (22.6%) | 286 | 70 | 203/0/436/566 | $31,167 | **24.7** | 18.9 | 51.4 | $370 (1.4%) | 101 | 48 | 1182/11/197/0 |
| 30d Δ0.3 w5.0% skew3 pt0.75 sl– ts– | $33,729 | **34.9** | 26.6 | 42.2 | $10,007 (29.7%) | 216 | 83 | 27/0/292/932 | $30,644 | **22.6** | 17.4 | 42.9 | $895 (3.2%) | 78 | 53 | 1159/19/211/0 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $9,192 | **-63.2** | -55.2 | -111.0 | $23,863 (80.2%) | 315 | 57 | 62/248/497/342 | $30,289 | **21.2** | 16.6 | 51.1 | $314 (1.2%) | 113 | 41 | 1160/2/189/0 |
| 30d Δ0.3 w5.0% skew3 pt– sl– ts– | $35,864 | **43.5** | 32.8 | 52.4 | $6,898 (17.8%) | 146 | 83 | 21/0/152/1148 | $29,778 | **19.1** | 14.7 | 26.2 | $447 (1.6%) | 59 | 73 | 1156/42/210/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | $33,610 | **34.4** | 26.2 | 65.1 | $7,732 (21.5%) | 178 | 53 | 46/0/298/56 | $27,430 | **9.7** | 7.6 | 36.5 | $450 (1.8%) | 49 | 27 | 441/1/87/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | $51,369 | **105.5** | 76.2 | 201.5 | $3,964 (7.9%) | 224 | 52 | 171/0/416/68 | $30,265 | **21.1** | 16.2 | 52.0 | $405 (1.6%) | 87 | 40 | 634/4/154/0 |

## 8. Ranking within the day (BPS-10) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25%, top 5 of each day's eligible set

lift = mean return of the chosen 5 minus the mean of that day's whole eligible set, averaged over days. The null band is 500 random choices of 5 on the same days. p = share of random choices that did at least as well.

skew 3: no day had more than 5 eligible candidates — the cut never binds here.
skew 0: no day had more than 5 eligible candidates — the cut never binds here.
skew 6: no day had more than 5 eligible candidates — the cut never binds here.

## 9. Cost-gate sweep (BPS-9) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– with round-trip cost ≤ X% of mid credit

Fallback slip $0.03/leg for entries without quotes. Each row keeps the entries whose spread clears the gate; the CSP columns are the SAME entries.

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| no gate — all (475/475 pass) | 475 | 75.8 | -2.51 | 9.21 | **-0.151** | 16.6 | T81 S0 H0 E19 | 89.7 | 0.73 | 1.21 | **0.056** | 13.0 |
| cost ≤ 40% — all (276/475 pass) | 276 | 84.8 | 1.06 | 13.52 | **0.068** | 15.5 | T82 S0 H0 E18 | 88.8 | 0.75 | 1.30 | **0.059** | 12.6 |
| cost ≤ 35% — all (252/475 pass) | 252 | 85.3 | 1.72 | 13.76 | **0.111** | 15.5 | T83 S0 H0 E17 | 88.9 | 0.74 | 1.27 | **0.058** | 12.7 |
| cost ≤ 30% — all (229/475 pass) | 229 | 86.5 | 3.05 | 14.26 | **0.198** | 15.4 | T84 S0 H0 E16 | 89.5 | 0.76 | 1.30 | **0.060** | 12.6 |
| cost ≤ 25% — all (188/475 pass) | 188 | 85.6 | 3.01 | 14.86 | **0.196** | 15.3 | T84 S0 H0 E16 | 88.8 | 0.70 | 1.32 | **0.056** | 12.6 |
| cost ≤ 20% — all (145/475 pass) | 145 | 86.2 | 4.92 | 15.57 | **0.317** | 15.5 | T83 S0 H0 E17 | 89.7 | 0.82 | 1.35 | **0.063** | 13.0 |
| cost ≤ 15% — all (98/475 pass) | 98 | 84.7 | 4.64 | 16.22 | **0.308** | 15.1 | T83 S0 H0 E17 | 88.8 | 0.91 | 1.38 | **0.075** | 12.2 |
| no gate — quoted only (376/376) | 376 | 72.3 | -4.75 | 7.31 | **-0.275** | 17.3 | T81 S0 H0 E19 | 89.1 | 0.59 | 1.17 | **0.043** | 13.5 |
| cost ≤ 40% — quoted only (185/376) | 185 | 82.7 | -1.51 | 12.51 | **-0.091** | 16.6 | T81 S0 H0 E19 | 87.6 | 0.51 | 1.23 | **0.038** | 13.6 |
| cost ≤ 35% — quoted only (165/376) | 165 | 83.6 | -0.52 | 13.17 | **-0.032** | 16.4 | T82 S0 H0 E18 | 87.9 | 0.53 | 1.22 | **0.040** | 13.5 |
| cost ≤ 30% — quoted only (144/376) | 144 | 85.4 | 1.61 | 13.71 | **0.100** | 16.2 | T84 S0 H0 E16 | 88.9 | 0.61 | 1.27 | **0.046** | 13.3 |
| cost ≤ 25% — quoted only (117/376) | 117 | 85.5 | 2.36 | 14.09 | **0.145** | 16.3 | T84 S0 H0 E16 | 88.9 | 0.55 | 1.25 | **0.041** | 13.4 |
| cost ≤ 20% — quoted only (90/376) | 90 | 85.6 | 4.01 | 15.37 | **0.239** | 16.7 | T83 S0 H0 E17 | 88.9 | 0.61 | 1.33 | **0.043** | 14.2 |
| cost ≤ 15% — quoted only (62/376) | 62 | 83.9 | 4.57 | 16.98 | **0.281** | 16.3 | T82 S0 H0 E18 | 88.7 | 0.88 | 1.42 | **0.066** | 13.3 |

Portfolio, same pot and sizing as §7, every replay day:

| gate | SPREAD final | return % | ann. % | max DD | trades | CSP final | return % | max DD | trades |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| none | $9,475 | **-62.1** | -53.4 | $20,569 (68.5%) | 250 | $31,167 | **24.7** | $370 (1.4%) | 101 |
| ≤ 40% | $28,917 | **15.7** | 12.1 | $12,150 (29.6%) | 242 | $30,128 | **20.5** | $405 (1.6%) | 84 |
| ≤ 35% | $38,229 | **52.9** | 39.7 | $9,400 (19.7%) | 223 | $29,156 | **16.6** | $406 (1.6%) | 79 |
| ≤ 30% | $34,135 | **36.5** | 27.8 | $8,409 (20.5%) | 208 | $28,405 | **13.6** | $432 (1.7%) | 71 |
| ≤ 25% | $33,610 | **34.4** | 26.2 | $7,732 (21.5%) | 178 | $27,430 | **9.7** | $450 (1.8%) | 49 |
| ≤ 20% | $36,230 | **44.9** | 33.9 | $6,496 (15.7%) | 142 | $27,254 | **9.0** | $166 (0.6%) | 26 |
| ≤ 15% | $31,770 | **27.1** | 21.5 | $7,656 (22.0%) | 92 | $25,077 | **0.3** | $0 (0.0%) | 1 |

Read: a gate earns its level if tightening it improves the spread's mean and tail on the QUOTED rows without emptying the sample; a flat or noisy curve means the level is a judgement call, not a finding.

78 configurations were compared in §2–4c and §9, and 16 portfolios in §7 and §9; expect the best to look better than it is. Prefer a setting that is good across neighbours over the single top row.
