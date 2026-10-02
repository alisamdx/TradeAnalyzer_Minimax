# Bull put spread vs CSP — wheel replay entries (prices to 2026-10-01, slip: quoted per ticker (0.5 × median half-spread, intraday quotes), fallback $0/leg)

Replay picks 1495 → unsettled 0, no bars 0, excluded as split 0 / ticker reuse 0, usable 1495 → **480 episodes** (1015 repeat entries collapsed). IV from rolling vol (no iv_history): 16.
Entry dates 2025-06-02 … 2026-08-10.

Genuine >35% moves KEPT in the sample (3): CGNX 2026-02-12 (36%); ORCL 2025-09-10 (36%); SNPS 2025-09-10 (-36%)

Quoted slippage (intraday quotes only): 141 tickers with ≥3 quotes — 141 from intraday, 0 from after-close. Rows read: briefCandidatesIntraday 1022, briefCandidatesAfterClose 1246, spreadChainsIntraday 28353, spreadChainsAfterClose 34830, premiumHistoryAfterClose 68825. Per leg: p10 $0.022 · median $0.150 · p90 $0.700. Entries priced from quotes: 496 of 1495; the rest use the $0 fallback.

ret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.

## 1. Draft profile — 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| episodes | 478 | 71.5 | 2.87 | 10.13 | **0.281** | 10.2 | T63 S7 H30 E0 | 84.3 | 0.64 | 0.95 | **0.072** | 8.9 |
| pooled (every replay day) | 1492 | 71.2 | 2.46 | 9.54 | **0.236** | 10.4 | T63 S7 H31 E0 | 83.6 | 0.60 | 0.95 | **0.065** | 9.3 |

Tails (episodes): spread p5 -43.0% / worst $-2410 per contract; CSP p5 -3.3% / worst $-11643. Avg P&L per contract: spread $13, CSP $102.
Credit as % of width (5%-of-spot wing): p10 13 · p25 16 · median 19 · p75 21 · p90 24.
Round-trip cost (4 leg-fills) as % of mid credit: p10 0 · p25 0 · median 0 · p75 17 · p90 54.
IV rank at entry (episodes with a rank, 287): <30 2 · 30–50 1 · 50–80 47 · ≥80 237

## 2. Exit grid (30d Δ0.25 w5% skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts10 | 478 | 63.4 | 0.88 | 6.19 | **0.118** | 7.5 | T46 S15 H40 E0 | 75.1 | 0.50 | 0.79 | **0.072** | 7.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts15 | 478 | 68.8 | 1.77 | 9.95 | **0.194** | 9.1 | T60 S19 H21 E0 | 80.1 | 0.53 | 0.92 | **0.065** | 8.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts– | 478 | 73.8 | 2.12 | 11.81 | **0.206** | 10.3 | T74 S25 H0 E1 | 82.2 | 0.47 | 1.01 | **0.053** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts10 | 478 | 63.6 | 1.70 | 6.19 | **0.212** | 8.0 | T47 S4 H50 E0 | 75.9 | 0.58 | 0.79 | **0.080** | 7.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 71.5 | 2.87 | 10.13 | **0.281** | 10.2 | T63 S7 H30 E0 | 84.3 | 0.64 | 0.95 | **0.072** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts– | 478 | 82.6 | 3.89 | 12.66 | **0.313** | 12.4 | T84 S13 H0 E3 | 90.2 | 0.66 | 1.09 | **0.064** | 10.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts10 | 478 | 63.6 | 1.43 | 6.19 | **0.174** | 8.2 | T47 S0 H53 E0 | 75.9 | 0.58 | 0.79 | **0.077** | 7.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts15 | 478 | 71.8 | 2.91 | 10.13 | **0.274** | 10.6 | T63 S0 H37 E0 | 85.1 | 0.69 | 0.95 | **0.075** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 478 | 86.0 | 4.67 | 13.09 | **0.330** | 14.1 | T87 S0 H0 E13 | 93.9 | 0.85 | 1.11 | **0.074** | 11.5 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts10 | 478 | 62.1 | 1.21 | 6.15 | **0.138** | 8.8 | T25 S15 H60 E0 | 72.8 | 0.48 | 0.84 | **0.055** | 8.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts15 | 478 | 65.9 | 2.30 | 9.73 | **0.203** | 11.3 | T44 S20 H36 E0 | 77.0 | 0.54 | 1.10 | **0.049** | 11.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts– | 478 | 70.3 | 3.15 | 15.72 | **0.229** | 13.7 | T70 S28 H0 E2 | 78.0 | 0.56 | 1.34 | **0.042** | 13.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts10 | 478 | 62.3 | 2.11 | 6.15 | **0.224** | 9.4 | T25 S4 H71 E0 | 73.6 | 0.57 | 0.84 | **0.063** | 9.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts15 | 478 | 68.6 | 3.55 | 9.90 | **0.282** | 12.6 | T45 S7 H48 E0 | 81.2 | 0.67 | 1.11 | **0.057** | 11.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts– | 478 | 80.5 | 5.52 | 17.23 | **0.338** | 16.3 | T78 S15 H0 E7 | 86.6 | 0.78 | 1.44 | **0.052** | 14.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts10 | 478 | 62.3 | 1.84 | 6.15 | **0.192** | 9.6 | T25 S0 H75 E0 | 73.6 | 0.58 | 0.84 | **0.063** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts15 | 478 | 68.8 | 3.59 | 9.90 | **0.277** | 13.0 | T45 S0 H55 E0 | 82.0 | 0.73 | 1.11 | **0.061** | 12.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts– | 478 | 84.9 | 6.63 | 17.65 | **0.364** | 18.2 | T81 S0 H0 E19 | 90.6 | 1.01 | 1.48 | **0.061** | 16.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts10 | 478 | 62.1 | 1.35 | 5.93 | **0.138** | 9.8 | T0 S15 H85 E0 | 72.8 | 0.51 | 0.82 | **0.050** | 10.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts15 | 478 | 63.8 | 2.16 | 8.77 | **0.156** | 13.8 | T0 S20 H80 E0 | 75.9 | 0.56 | 1.09 | **0.039** | 14.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts– | 478 | 68.0 | 4.46 | 19.66 | **0.181** | 24.6 | T0 S30 H0 E70 | 74.7 | 0.67 | 1.58 | **0.026** | 25.9 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts10 | 478 | 62.6 | 2.25 | 5.93 | **0.216** | 10.4 | T0 S4 H96 E0 | 73.6 | 0.60 | 0.83 | **0.057** | 10.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts15 | 478 | 66.7 | 3.42 | 9.39 | **0.226** | 15.1 | T0 S7 H93 E0 | 80.1 | 0.70 | 1.11 | **0.046** | 15.2 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts– | 478 | 79.1 | 7.20 | 20.74 | **0.258** | 27.9 | T0 S16 H0 E84 | 84.1 | 0.93 | 1.73 | **0.033** | 28.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts10 | 478 | 62.6 | 1.99 | 5.93 | **0.187** | 10.6 | T0 S0 H100 E0 | 73.6 | 0.61 | 0.83 | **0.057** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts15 | 478 | 66.9 | 3.46 | 9.39 | **0.223** | 15.5 | T0 S0 H100 E0 | 81.0 | 0.76 | 1.11 | **0.049** | 15.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts– | 478 | 84.7 | 8.60 | 20.99 | **0.287** | 30.0 | T0 S0 H0 E100 | 88.1 | 1.16 | 1.74 | **0.039** | 30.0 |

## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew0 pt0.5 sl2 ts15 | 479 | 72.4 | 3.67 | 11.18 | **0.379** | 9.7 | T65 S7 H28 E0 | 82.9 | 0.57 | 0.91 | **0.068** | 8.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 71.5 | 2.87 | 10.13 | **0.281** | 10.2 | T63 S7 H30 E0 | 84.3 | 0.64 | 0.95 | **0.072** | 8.9 |
| 30d Δ0.25 w5.0% skew6 pt0.5 sl2 ts15 | 478 | 70.3 | 1.88 | 8.55 | **0.176** | 10.7 | T62 S7 H32 E0 | 84.7 | 0.68 | 1.00 | **0.073** | 9.3 |

## 4. Entry DTE × short delta (draft exits, w5%, skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 21d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 475 | 78.5 | 2.62 | 8.33 | **0.348** | 7.5 | T80 S12 H8 E0 | 89.7 | 0.46 | 0.67 | **0.067** | 6.9 |
| 21d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 78.3 | 3.51 | 10.83 | **0.417** | 8.4 | T77 S10 H12 E0 | 87.5 | 0.54 | 0.87 | **0.073** | 7.3 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 76.6 | 4.09 | 13.31 | **0.449** | 9.1 | T73 S9 H18 E0 | 86.6 | 0.68 | 1.03 | **0.086** | 7.9 |
| 30d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 475 | 73.1 | 2.39 | 7.62 | **0.249** | 9.6 | T67 S8 H25 E0 | 86.5 | 0.56 | 0.79 | **0.067** | 8.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 478 | 71.5 | 2.87 | 10.13 | **0.281** | 10.2 | T63 S7 H30 E0 | 84.3 | 0.64 | 0.95 | **0.072** | 8.9 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 69.1 | 3.45 | 11.83 | **0.317** | 10.9 | T58 S5 H36 E0 | 82.9 | 0.79 | 1.16 | **0.084** | 9.4 |
| 35d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 476 | 70.6 | 2.48 | 7.68 | **0.246** | 10.1 | T63 S7 H30 E0 | 84.5 | 0.59 | 0.82 | **0.066** | 8.9 |
| 35d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 69.1 | 2.92 | 9.53 | **0.273** | 10.7 | T59 S5 H36 E0 | 82.7 | 0.64 | 0.99 | **0.067** | 9.4 |
| 35d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 67.0 | 3.10 | 10.92 | **0.269** | 11.5 | T53 S4 H43 E0 | 81.0 | 0.77 | 1.21 | **0.078** | 9.9 |

## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 478 | 86.0 | 4.67 | 13.09 | **0.330** | 14.1 | T87 S0 H0 E13 | 93.9 | 0.85 | 1.11 | **0.074** | 11.5 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– | 479 | 89.6 | 5.16 | 10.66 | **0.390** | 13.2 | T89 S0 H0 E11 | 93.9 | 0.85 | 1.11 | **0.074** | 11.5 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– | 480 | 91.0 | 4.78 | 9.20 | **0.374** | 12.8 | T90 S0 H0 E10 | 94.0 | 0.85 | 1.11 | **0.074** | 11.5 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | 479 | 84.6 | 5.45 | 16.54 | **0.355** | 15.4 | T84 S0 H0 E16 | 90.6 | 0.95 | 1.38 | **0.076** | 12.5 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– | 479 | 87.7 | 5.80 | 14.14 | **0.401** | 14.5 | T86 S0 H0 E14 | 90.6 | 0.95 | 1.38 | **0.076** | 12.5 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | 480 | 88.1 | 5.43 | 12.07 | **0.388** | 14.0 | T86 S0 H0 E14 | 90.6 | 0.95 | 1.38 | **0.076** | 12.5 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– | 479 | 81.8 | 5.03 | 19.89 | **0.308** | 16.3 | T79 S0 H0 E21 | 87.7 | 1.01 | 1.62 | **0.075** | 13.5 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– | 480 | 85.0 | 5.73 | 17.04 | **0.372** | 15.4 | T82 S0 H0 E18 | 87.7 | 1.01 | 1.62 | **0.075** | 13.5 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– | 480 | 86.7 | 6.43 | 14.64 | **0.432** | 14.9 | T83 S0 H0 E17 | 87.7 | 1.01 | 1.62 | **0.075** | 13.5 |

## 4c. Same grid, liquid entries only — round-trip cost (open + close, both legs) ≤ 25% of the mid credit

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 383 | 90.9 | 7.20 | 14.13 | **0.521** | 13.8 | T88 S0 H0 E12 | 94.8 | 0.92 | 1.15 | **0.081** | 11.4 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 395 | 92.2 | 6.52 | 11.66 | **0.498** | 13.1 | T90 S0 H0 E10 | 94.4 | 0.92 | 1.16 | **0.080** | 11.5 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 408 | 92.6 | 5.72 | 9.98 | **0.450** | 12.7 | T90 S0 H0 E10 | 94.4 | 0.93 | 1.16 | **0.081** | 11.5 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 393 | 86.5 | 7.59 | 18.26 | **0.500** | 15.2 | T84 S0 H0 E16 | 90.6 | 1.00 | 1.41 | **0.078** | 12.8 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 409 | 88.0 | 6.71 | 14.97 | **0.465** | 14.4 | T86 S0 H0 E14 | 90.5 | 1.01 | 1.42 | **0.079** | 12.8 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 423 | 88.7 | 6.27 | 12.81 | **0.452** | 13.9 | T86 S0 H0 E14 | 90.8 | 1.03 | 1.43 | **0.082** | 12.6 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 401 | 82.5 | 6.66 | 21.82 | **0.408** | 16.3 | T78 S0 H0 E22 | 87.5 | 1.04 | 1.62 | **0.076** | 13.7 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 423 | 85.3 | 6.99 | 18.25 | **0.460** | 15.2 | T82 S0 H0 E18 | 87.9 | 1.09 | 1.64 | **0.081** | 13.4 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 439 | 86.8 | 7.06 | 15.20 | **0.481** | 14.7 | T83 S0 H0 E17 | 87.7 | 1.04 | 1.64 | **0.078** | 13.4 |

## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| credit ≥ 20% of width | 173 | 76.9 | 6.23 | 15.27 | **0.600** | 10.4 | T64 S4 H32 E0 | 83.2 | 1.02 | 1.49 | **0.111** | 9.2 |
| credit < 20% of width | 305 | 68.5 | 0.96 | 7.64 | **0.095** | 10.1 | T63 S8 H29 E0 | 84.9 | 0.43 | 0.80 | **0.049** | 8.8 |
| round-trip cost ≤ 25% of credit | 383 | 77.5 | 5.21 | 11.70 | **0.513** | 10.2 | T64 S5 H31 E0 | 84.3 | 0.70 | 0.98 | **0.078** | 9.0 |
| round-trip cost 25–50% of credit | 42 | 59.5 | -0.72 | 4.87 | **-0.067** | 10.7 | T55 S5 H40 E0 | 85.7 | 0.86 | 0.95 | **0.093** | 9.3 |
| round-trip cost > 50% of credit | 53 | 37.7 | -11.17 | -4.08 | **-1.082** | 10.3 | T62 S19 H19 E0 | 83.0 | 0.06 | 0.80 | **0.007** | 8.3 |
| IV rank ≥ 30 | 285 | 73.3 | 4.01 | 11.09 | **0.407** | 9.9 | T67 S5 H28 E0 | 84.9 | 0.86 | 1.07 | **0.101** | 8.4 |
| IV rank < 30 | 2 | 50.0 | 1.29 | 9.69 | **0.074** | 17.5 | T50 S0 H50 E0 | 50.0 | -1.01 | 0.41 | **-0.084** | 12.0 |
| IV rank unknown | 191 | 69.1 | 1.18 | 7.84 | **0.111** | 10.7 | T57 S9 H34 E0 | 83.8 | 0.34 | 0.80 | **0.036** | 9.6 |
| close above SMA50 | 410 | 70.2 | 2.20 | 9.95 | **0.215** | 10.2 | T63 S7 H30 E0 | 83.9 | 0.59 | 0.94 | **0.066** | 8.9 |
| close below SMA50 | 68 | 79.4 | 6.89 | 11.03 | **0.683** | 10.1 | T65 S3 H32 E0 | 86.8 | 0.96 | 1.00 | **0.107** | 9.0 |
| quoted slip ≤ $0.03/leg | 18 | 50.0 | -0.01 | 8.30 | **-0.001** | 11.7 | T50 S11 H39 E0 | 94.4 | 0.89 | 1.01 | **0.106** | 8.4 |
| quoted slip > $0.03/leg | 115 | 52.2 | -4.88 | 1.38 | **-0.470** | 10.4 | T61 S10 H29 E0 | 81.7 | 0.45 | 0.85 | **0.050** | 8.9 |
| no quotes (fallback slip) | 345 | 79.1 | 5.60 | 12.04 | **0.556** | 10.1 | T65 S5 H30 E0 | 84.6 | 0.70 | 0.99 | **0.078** | 8.9 |

## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 2025-Q2 | 33 | 72.7 | 4.44 | 8.78 | **0.404** | 11.0 | T61 S3 H36 E0 | 87.9 | 0.49 | 0.66 | **0.047** | 10.3 |
| 2025-Q3 | 115 | 69.6 | -1.19 | 7.84 | **-0.115** | 10.3 | T56 S13 H31 E0 | 78.3 | 0.07 | 0.83 | **0.007** | 9.3 |
| 2025-Q4 | 97 | 76.3 | 7.52 | 11.24 | **0.781** | 9.6 | T69 S3 H28 E0 | 94.8 | 1.12 | 1.09 | **0.138** | 8.1 |
| 2026-Q1 | 102 | 66.7 | 0.01 | 8.89 | **0.001** | 10.5 | T64 S9 H27 E0 | 80.4 | 0.45 | 0.90 | **0.052** | 8.7 |
| 2026-Q2 | 85 | 75.3 | 5.16 | 11.12 | **0.496** | 10.4 | T67 S2 H31 E0 | 85.9 | 1.06 | 1.16 | **0.115** | 9.2 |
| 2026-Q3 | 46 | 69.6 | 4.21 | 11.78 | **0.426** | 9.9 | T63 S4 H33 E0 | 80.4 | 0.83 | 1.30 | **0.099** | 8.4 |

## 7. Portfolio — $25,000 pot, every replay day in pick-rank order, one position per ticker, ≤ 10 open
Spread sized to ≤ $2500 max loss per position; CSP to ≤ 25% of the pot in cash per position. P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, capital = no free cash, dup = ticker already open, full = position cap.

on deployed % = total P&L ÷ average capital in use. Gated rows (cost≤) filter BOTH columns to the same liquid entries.

| config | SPREAD final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full |
|---|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | $52,952 | **111.8** | 84.1 | 140.7 | $8,845 (31.4%) | 411 | 79 | 53/4/590/434 | $29,718 | **18.9** | 15.1 | 48.4 | $329 (1.2%) | 113 | 39 | 1179/4/196/0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | $48,356 | **93.4** | 68.0 | 116.7 | $12,352 (25.8%) | 305 | 80 | 34/0/355/798 | $30,782 | **23.1** | 17.8 | 50.7 | $367 (1.4%) | 104 | 46 | 1179/7/202/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $63,847 | **155.4** | 109.1 | 186.5 | $8,697 (21.8%) | 293 | 83 | 37/0/359/804 | $31,706 | **26.8** | 20.6 | 56.2 | $367 (1.4%) | 101 | 48 | 1184/9/199/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | $68,925 | **175.7** | 122.1 | 254.5 | $4,218 (7.9%) | 298 | 69 | 188/0/440/569 | $31,706 | **26.8** | 20.6 | 56.2 | $367 (1.4%) | 101 | 48 | 1186/9/199/0 |
| 30d Δ0.3 w5.0% skew3 pt0.75 sl– ts– | $84,798 | **239.2** | 161.4 | 286.5 | $6,010 (8.7%) | 232 | 83 | 31/0/314/916 | $31,420 | **25.7** | 19.7 | 45.9 | $887 (3.1%) | 81 | 56 | 1185/17/210/0 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $78,445 | **213.8** | 150.3 | 261.6 | $7,994 (18.5%) | 397 | 82 | 47/0/493/556 | $31,140 | **24.6** | 19.3 | 57.2 | $257 (1.0%) | 117 | 43 | 1186/1/189/0 |
| 30d Δ0.3 w5.0% skew3 pt– sl– ts– | $56,310 | **125.2** | 89.4 | 148.7 | $5,348 (10.3%) | 146 | 84 | 20/0/149/1178 | $30,020 | **20.1** | 15.5 | 27.6 | $444 (1.6%) | 59 | 73 | 1182/42/210/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | $67,069 | **168.3** | 117.3 | 213.0 | $10,823 (16.2%) | 277 | 79 | 47/0/396/521 | $31,178 | **24.7** | 19.0 | 54.5 | $367 (1.4%) | 95 | 45 | 967/7/172/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | $71,379 | **185.5** | 128.3 | 278.7 | $4,218 (7.1%) | 288 | 67 | 196/0/466/403 | $31,396 | **25.6** | 19.6 | 55.1 | $367 (1.4%) | 98 | 46 | 1064/7/184/0 |

## 8. Ranking within the day (BPS-10) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25%, top 5 of each day's eligible set

lift = mean return of the chosen 5 minus the mean of that day's whole eligible set, averaged over days. The null band is 500 random choices of 5 on the same days. p = share of random choices that did at least as well.

skew 3: no day had more than 5 eligible candidates — the cut never binds here.
skew 0: no day had more than 5 eligible candidates — the cut never binds here.
skew 6: no day had more than 5 eligible candidates — the cut never binds here.

64 configurations were compared in §2–4c and 9 in §7; expect the best to look better than it is. Prefer a setting that is good across neighbours over the single top row.
