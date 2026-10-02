# Bull put spread vs CSP — wheel replay entries (prices to 2026-10-01, slip: quoted per ticker (0.5 × median half-spread, intraday quotes), fallback $0.03/leg)

Replay picks 1495 → unsettled 0, no bars 0, excluded as split 0 / ticker reuse 0, usable 1495 → **480 episodes** (1015 repeat entries collapsed). IV from rolling vol (no iv_history): 16.
Entry dates 2025-06-02 … 2026-08-10.

Genuine >35% moves KEPT in the sample (3): CGNX 2026-02-12 (36%); ORCL 2025-09-10 (36%); SNPS 2025-09-10 (-36%)

Quoted slippage (intraday quotes only): 141 tickers with ≥3 quotes — 141 from intraday, 0 from after-close. Rows read: briefCandidatesIntraday 1022, briefCandidatesAfterClose 1246, spreadChainsIntraday 28353, spreadChainsAfterClose 34830, premiumHistoryAfterClose 68825. Per leg: p10 $0.022 · median $0.150 · p90 $0.700. Entries priced from quotes: 496 of 1495; the rest use the $0.03 fallback.

ret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.

## 1. Draft profile — 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| episodes | 478 | 67.8 | 0.46 | 7.40 | **0.045** | 10.3 | T62 S8 H30 E0 | 83.3 | 0.59 | 0.90 | **0.066** | 9.0 |
| pooled (every replay day) | 1490 | 67.4 | 0.42 | 7.47 | **0.039** | 10.6 | T61 S8 H31 E0 | 83.0 | 0.57 | 0.91 | **0.061** | 9.3 |

Tails (episodes): spread p5 -45.6% / worst $-2422 per contract; CSP p5 -3.3% / worst $-11649. Avg P&L per contract: spread $4, CSP $97.
Credit as % of width (5%-of-spot wing): p10 13 · p25 15 · median 18 · p75 20 · p90 23.
Round-trip cost (4 leg-fills) as % of mid credit: p10 3 · p25 6 · median 12 · p75 31 · p90 58.
IV rank at entry (episodes with a rank, 287): <30 2 · 30–50 1 · 50–80 47 · ≥80 237

## 2. Exit grid (30d Δ0.25 w5% skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts10 | 478 | 59.4 | -1.54 | 4.26 | **-0.204** | 7.5 | T44 S16 H40 E0 | 74.5 | 0.46 | 0.76 | **0.066** | 7.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts15 | 478 | 65.5 | -0.59 | 7.20 | **-0.064** | 9.2 | T59 S21 H20 E0 | 79.5 | 0.48 | 0.89 | **0.059** | 8.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts– | 478 | 71.8 | -0.45 | 9.54 | **-0.044** | 10.3 | T72 S27 H0 E1 | 81.2 | 0.40 | 0.98 | **0.045** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts10 | 478 | 59.8 | -0.60 | 4.33 | **-0.073** | 8.2 | T45 S4 H50 E0 | 75.3 | 0.53 | 0.76 | **0.072** | 7.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 67.8 | 0.46 | 7.40 | **0.045** | 10.3 | T62 S8 H30 E0 | 83.3 | 0.59 | 0.90 | **0.066** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts– | 478 | 81.2 | 1.47 | 10.63 | **0.118** | 12.5 | T82 S14 H0 E3 | 89.5 | 0.60 | 1.05 | **0.057** | 10.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts10 | 478 | 59.8 | -0.83 | 4.33 | **-0.099** | 8.4 | T45 S0 H55 E0 | 75.3 | 0.53 | 0.76 | **0.070** | 7.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts15 | 478 | 68.2 | 0.67 | 7.45 | **0.062** | 10.8 | T62 S0 H38 E0 | 84.3 | 0.64 | 0.90 | **0.069** | 9.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 478 | 85.1 | 2.52 | 10.98 | **0.174** | 14.5 | T86 S0 H0 E14 | 93.7 | 0.80 | 1.08 | **0.069** | 11.6 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts10 | 478 | 58.2 | -1.23 | 3.78 | **-0.140** | 8.8 | T23 S17 H60 E0 | 72.4 | 0.44 | 0.77 | **0.050** | 8.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts15 | 478 | 62.6 | -0.17 | 7.48 | **-0.015** | 11.3 | T41 S22 H37 E0 | 76.4 | 0.49 | 1.07 | **0.045** | 10.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts– | 478 | 68.0 | 0.37 | 12.92 | **0.027** | 13.7 | T68 S31 H0 E2 | 77.4 | 0.50 | 1.31 | **0.038** | 13.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts10 | 478 | 58.6 | -0.27 | 3.87 | **-0.029** | 9.5 | T24 S4 H72 E0 | 73.2 | 0.51 | 0.78 | **0.057** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts15 | 478 | 64.9 | 1.04 | 7.85 | **0.082** | 12.6 | T43 S8 H49 E0 | 80.1 | 0.61 | 1.09 | **0.052** | 11.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts– | 478 | 79.3 | 3.13 | 14.36 | **0.192** | 16.3 | T77 S16 H0 E7 | 86.4 | 0.73 | 1.39 | **0.049** | 14.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts10 | 478 | 58.6 | -0.50 | 3.87 | **-0.052** | 9.7 | T24 S0 H76 E0 | 73.2 | 0.53 | 0.78 | **0.057** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts15 | 478 | 65.3 | 1.25 | 7.93 | **0.096** | 13.1 | T43 S0 H57 E0 | 81.2 | 0.69 | 1.09 | **0.057** | 12.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts– | 478 | 84.5 | 4.61 | 14.89 | **0.249** | 18.5 | T81 S0 H0 E19 | 90.6 | 0.96 | 1.40 | **0.058** | 16.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts10 | 478 | 58.2 | -1.11 | 3.27 | **-0.115** | 9.7 | T0 S17 H83 E0 | 72.4 | 0.47 | 0.76 | **0.046** | 10.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts15 | 478 | 60.7 | -0.35 | 7.07 | **-0.026** | 13.7 | T0 S22 H78 E0 | 75.1 | 0.52 | 1.05 | **0.037** | 14.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts– | 478 | 65.9 | 2.23 | 18.10 | **0.093** | 24.1 | T0 S32 H0 E68 | 74.1 | 0.64 | 1.57 | **0.025** | 25.7 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts10 | 478 | 58.8 | -0.15 | 3.83 | **-0.014** | 10.4 | T0 S4 H96 E0 | 73.2 | 0.54 | 0.77 | **0.052** | 10.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts15 | 478 | 63.2 | 0.87 | 7.58 | **0.058** | 15.0 | T0 S8 H92 E0 | 78.9 | 0.64 | 1.07 | **0.042** | 15.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts– | 478 | 77.8 | 5.36 | 19.27 | **0.194** | 27.6 | T0 S17 H0 E83 | 83.9 | 0.90 | 1.70 | **0.032** | 28.2 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts10 | 478 | 58.8 | -0.38 | 3.83 | **-0.036** | 10.6 | T0 S0 H100 E0 | 73.2 | 0.56 | 0.77 | **0.053** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts15 | 478 | 63.6 | 1.08 | 7.61 | **0.070** | 15.5 | T0 S0 H100 E0 | 79.9 | 0.72 | 1.08 | **0.046** | 15.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts– | 478 | 84.5 | 7.29 | 19.63 | **0.243** | 30.0 | T0 S0 H0 E100 | 88.1 | 1.14 | 1.71 | **0.038** | 30.0 |

## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew0 pt0.5 sl2 ts15 | 479 | 69.5 | 1.26 | 8.88 | **0.129** | 9.8 | T65 S8 H27 E0 | 82.7 | 0.51 | 0.87 | **0.061** | 8.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 67.8 | 0.46 | 7.40 | **0.045** | 10.3 | T62 S8 H30 E0 | 83.3 | 0.59 | 0.90 | **0.066** | 9.0 |
| 30d Δ0.25 w5.0% skew6 pt0.5 sl2 ts15 | 478 | 65.7 | -0.34 | 6.29 | **-0.031** | 11.0 | T59 S8 H33 E0 | 84.3 | 0.63 | 0.94 | **0.067** | 9.4 |

## 4. Entry DTE × short delta (draft exits, w5%, skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 21d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 472 | 76.5 | 0.62 | 6.22 | **0.079** | 7.8 | T79 S13 H8 E0 | 89.6 | 0.42 | 0.64 | **0.061** | 7.0 |
| 21d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 477 | 76.9 | 1.21 | 8.79 | **0.141** | 8.6 | T76 S11 H12 E0 | 87.4 | 0.50 | 0.82 | **0.068** | 7.4 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 74.7 | 1.72 | 11.24 | **0.184** | 9.4 | T71 S10 H19 E0 | 86.4 | 0.64 | 0.99 | **0.081** | 7.9 |
| 30d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 474 | 70.3 | 0.24 | 5.65 | **0.025** | 9.7 | T65 S9 H25 E0 | 85.0 | 0.50 | 0.75 | **0.060** | 8.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 67.8 | 0.46 | 7.40 | **0.045** | 10.3 | T62 S8 H30 E0 | 83.3 | 0.59 | 0.90 | **0.066** | 9.0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 66.2 | 0.97 | 9.58 | **0.088** | 11.0 | T58 S6 H36 E0 | 81.6 | 0.73 | 1.12 | **0.077** | 9.4 |
| 35d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 476 | 66.4 | 0.06 | 5.57 | **0.005** | 10.3 | T61 S8 H31 E0 | 83.8 | 0.55 | 0.79 | **0.061** | 9.0 |
| 35d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 65.8 | 0.44 | 6.96 | **0.040** | 11.0 | T56 S7 H37 E0 | 81.4 | 0.59 | 0.96 | **0.062** | 9.5 |
| 35d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 63.5 | 0.58 | 8.73 | **0.050** | 11.7 | T52 S5 H43 E0 | 80.6 | 0.72 | 1.18 | **0.073** | 9.9 |

## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 478 | 85.1 | 2.52 | 10.98 | **0.174** | 14.5 | T86 S0 H0 E14 | 93.7 | 0.80 | 1.08 | **0.069** | 11.6 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– | 479 | 88.9 | 3.51 | 9.44 | **0.258** | 13.6 | T89 S0 H0 E11 | 93.7 | 0.80 | 1.07 | **0.069** | 11.6 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– | 480 | 90.8 | 3.93 | 8.21 | **0.302** | 13.0 | T90 S0 H0 E10 | 93.8 | 0.80 | 1.07 | **0.069** | 11.6 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | 479 | 84.3 | 3.20 | 14.53 | **0.205** | 15.6 | T83 S0 H0 E17 | 90.6 | 0.91 | 1.34 | **0.072** | 12.7 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– | 479 | 87.3 | 4.57 | 12.94 | **0.310** | 14.7 | T85 S0 H0 E15 | 90.6 | 0.91 | 1.34 | **0.072** | 12.7 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | 480 | 87.9 | 4.52 | 11.13 | **0.320** | 14.1 | T86 S0 H0 E14 | 90.6 | 0.91 | 1.34 | **0.072** | 12.7 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– | 479 | 81.6 | 2.76 | 17.64 | **0.167** | 16.6 | T78 S0 H0 E22 | 87.7 | 0.98 | 1.60 | **0.072** | 13.6 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– | 480 | 84.8 | 4.51 | 15.82 | **0.286** | 15.8 | T81 S0 H0 E19 | 87.7 | 0.98 | 1.60 | **0.072** | 13.6 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– | 480 | 86.5 | 5.42 | 13.77 | **0.360** | 15.1 | T83 S0 H0 E17 | 87.7 | 0.98 | 1.60 | **0.072** | 13.6 |

## 4c. Same grid, liquid entries only — round-trip cost (open + close, both legs) ≤ 25% of the mid credit

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 321 | 89.1 | 4.20 | 13.00 | **0.288** | 14.6 | T86 S0 H0 E14 | 93.8 | 0.80 | 1.12 | **0.066** | 12.1 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 367 | 90.7 | 4.35 | 10.55 | **0.316** | 13.8 | T89 S0 H0 E11 | 93.7 | 0.83 | 1.09 | **0.070** | 11.9 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 392 | 92.1 | 4.71 | 9.09 | **0.359** | 13.1 | T90 S0 H0 E10 | 93.9 | 0.86 | 1.11 | **0.073** | 11.8 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 354 | 85.3 | 4.54 | 16.08 | **0.292** | 15.6 | T83 S0 H0 E17 | 89.8 | 0.88 | 1.38 | **0.067** | 13.2 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 398 | 87.4 | 5.20 | 13.90 | **0.353** | 14.7 | T85 S0 H0 E15 | 90.2 | 0.94 | 1.38 | **0.073** | 13.0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 415 | 88.4 | 5.26 | 11.89 | **0.376** | 14.0 | T86 S0 H0 E14 | 90.6 | 0.98 | 1.38 | **0.077** | 12.7 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 379 | 81.5 | 3.48 | 19.67 | **0.208** | 16.7 | T78 S0 H0 E22 | 86.8 | 0.91 | 1.59 | **0.065** | 14.0 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 416 | 85.1 | 5.57 | 17.04 | **0.359** | 15.5 | T81 S0 H0 E19 | 87.7 | 1.04 | 1.62 | **0.077** | 13.5 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 435 | 86.7 | 6.00 | 14.39 | **0.405** | 14.8 | T83 S0 H0 E17 | 87.6 | 1.00 | 1.62 | **0.074** | 13.5 |

## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| credit ≥ 20% of width | 127 | 71.7 | 2.67 | 13.55 | **0.244** | 10.9 | T61 S6 H33 E0 | 81.9 | 0.99 | 1.52 | **0.101** | 9.8 |
| credit < 20% of width | 351 | 66.4 | -0.34 | 6.22 | **-0.033** | 10.1 | T63 S9 H28 E0 | 83.8 | 0.44 | 0.81 | **0.051** | 8.6 |
| round-trip cost ≤ 25% of credit | 321 | 73.8 | 2.59 | 10.07 | **0.245** | 10.6 | T62 S7 H31 E0 | 82.9 | 0.59 | 0.96 | **0.063** | 9.4 |
| round-trip cost 25–50% of credit | 94 | 67.0 | 0.73 | 6.13 | **0.073** | 9.9 | T63 S5 H32 E0 | 86.2 | 0.92 | 0.86 | **0.112** | 8.2 |
| round-trip cost > 50% of credit | 63 | 38.1 | -10.75 | -3.59 | **-1.085** | 9.9 | T60 S19 H21 E0 | 81.0 | 0.10 | 0.74 | **0.013** | 8.0 |
| IV rank ≥ 30 | 285 | 70.5 | 2.16 | 9.05 | **0.216** | 10.0 | T67 S6 H28 E0 | 84.2 | 0.81 | 1.03 | **0.095** | 8.5 |
| IV rank < 30 | 2 | 0.0 | -27.36 | -19.72 | **-4.209** | 6.5 | T0 S100 H0 E0 | 0.0 | -2.00 | -1.34 | **-0.267** | 7.5 |
| IV rank unknown | 191 | 64.4 | -1.78 | 5.51 | **-0.163** | 10.9 | T56 S11 H33 E0 | 82.7 | 0.29 | 0.78 | **0.030** | 9.7 |
| close above SMA50 | 410 | 66.3 | -0.31 | 6.68 | **-0.030** | 10.4 | T62 S9 H29 E0 | 82.7 | 0.53 | 0.89 | **0.060** | 9.0 |
| close below SMA50 | 68 | 76.5 | 5.14 | 9.34 | **0.499** | 10.3 | T65 S3 H32 E0 | 86.8 | 0.92 | 0.98 | **0.102** | 9.0 |
| quoted slip ≤ $0.03/leg | 18 | 50.0 | -0.01 | 8.30 | **-0.001** | 11.7 | T50 S11 H39 E0 | 94.4 | 0.89 | 1.01 | **0.106** | 8.4 |
| quoted slip > $0.03/leg | 115 | 52.2 | -4.88 | 1.38 | **-0.470** | 10.4 | T61 S10 H29 E0 | 81.7 | 0.45 | 0.85 | **0.050** | 8.9 |
| no quotes (fallback slip) | 345 | 73.9 | 2.27 | 9.47 | **0.221** | 10.3 | T63 S7 H30 E0 | 83.2 | 0.62 | 0.94 | **0.069** | 9.0 |

## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 2025-Q2 | 33 | 69.7 | 1.93 | 5.99 | **0.164** | 11.8 | T61 S3 H36 E0 | 84.8 | 0.43 | 0.58 | **0.042** | 10.4 |
| 2025-Q3 | 115 | 62.6 | -4.93 | 4.24 | **-0.473** | 10.4 | T54 S16 H30 E0 | 77.4 | 0.01 | 0.80 | **0.001** | 9.4 |
| 2025-Q4 | 97 | 73.2 | 5.35 | 8.36 | **0.541** | 9.9 | T68 S3 H29 E0 | 93.8 | 1.08 | 1.06 | **0.130** | 8.3 |
| 2026-Q1 | 102 | 64.7 | -1.53 | 7.31 | **-0.146** | 10.5 | T63 S11 H26 E0 | 79.4 | 0.39 | 0.85 | **0.044** | 8.8 |
| 2026-Q2 | 85 | 72.9 | 2.91 | 9.62 | **0.284** | 10.2 | T66 S5 H29 E0 | 84.7 | 1.00 | 1.14 | **0.110** | 9.1 |
| 2026-Q3 | 46 | 65.2 | 2.49 | 9.34 | **0.250** | 10.0 | T63 S4 H33 E0 | 80.4 | 0.80 | 1.28 | **0.095** | 8.4 |

## 7. Portfolio — $25,000 pot, every replay day in pick-rank order, one position per ticker, ≤ 10 open
Spread sized to ≤ $2500 max loss per position; CSP to ≤ 25% of the pot in cash per position. P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, capital = no free cash, dup = ticker already open, full = position cap.

on deployed % = total P&L ÷ average capital in use. Gated rows (cost≤) filter BOTH columns to the same liquid entries.

| config | SPREAD final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full |
|---|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | $33,188 | **32.8** | 25.9 | 42.2 | $12,028 (43.2%) | 400 | 78 | 51/11/570/458 | $28,979 | **15.9** | 12.8 | 39.8 | $341 (1.3%) | 116 | 40 | 1179/4/191/0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | $42,281 | **69.1** | 51.2 | 85.5 | $11,875 (25.5%) | 305 | 81 | 31/0/377/777 | $29,970 | **19.9** | 15.3 | 43.1 | $370 (1.4%) | 104 | 46 | 1179/9/198/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $43,875 | **75.5** | 55.7 | 90.6 | $10,110 (21.2%) | 285 | 83 | 37/0/358/813 | $31,369 | **25.5** | 19.5 | 53.3 | $370 (1.4%) | 101 | 48 | 1184/9/199/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | $59,041 | **136.2** | 96.6 | 194.8 | $4,608 (10.1%) | 298 | 70 | 195/0/439/563 | $31,369 | **25.5** | 19.5 | 53.3 | $370 (1.4%) | 101 | 48 | 1186/9/199/0 |
| 30d Δ0.3 w5.0% skew3 pt0.75 sl– ts– | $54,737 | **118.9** | 85.2 | 142.3 | $7,526 (14.0%) | 224 | 84 | 27/0/286/956 | $30,660 | **22.6** | 17.4 | 42.3 | $895 (3.2%) | 78 | 54 | 1185/17/213/0 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $45,369 | **81.5** | 61.3 | 99.2 | $14,161 (29.6%) | 383 | 82 | 45/0/496/568 | $30,457 | **21.8** | 17.2 | 52.4 | $272 (1.1%) | 114 | 42 | 1187/2/189/0 |
| 30d Δ0.3 w5.0% skew3 pt– sl– ts– | $52,139 | **108.6** | 78.3 | 128.6 | $5,414 (10.9%) | 146 | 84 | 20/0/149/1178 | $29,831 | **19.3** | 14.9 | 26.5 | $447 (1.6%) | 59 | 73 | 1182/42/210/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | $48,996 | **96.0** | 69.8 | 124.4 | $10,132 (19.2%) | 262 | 77 | 48/0/381/438 | $28,127 | **12.5** | 9.7 | 40.1 | $510 (2.0%) | 60 | 31 | 966/2/101/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | $62,619 | **150.5** | 105.9 | 226.2 | $4,386 (8.2%) | 286 | 67 | 197/0/457/386 | $30,723 | **22.9** | 17.6 | 53.0 | $370 (1.4%) | 93 | 43 | 1064/4/165/0 |

## 8. Ranking within the day (BPS-10) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25%, top 5 of each day's eligible set

lift = mean return of the chosen 5 minus the mean of that day's whole eligible set, averaged over days. The null band is 500 random choices of 5 on the same days. p = share of random choices that did at least as well.

skew 3: no day had more than 5 eligible candidates — the cut never binds here.
skew 0: no day had more than 5 eligible candidates — the cut never binds here.
skew 6: no day had more than 5 eligible candidates — the cut never binds here.

64 configurations were compared in §2–4c and 9 in §7; expect the best to look better than it is. Prefer a setting that is good across neighbours over the single top row.
