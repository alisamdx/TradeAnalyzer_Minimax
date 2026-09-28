# Bull put spread vs CSP — wheel replay entries (prices to 2026-09-25, slip: quoted per ticker (0.5 × median half-spread, intraday quotes), fallback $0/leg)

Replay picks 1495 → unsettled 0, no bars 0, excluded as split 0 / ticker reuse 0, usable 1495 → **480 episodes** (1015 repeat entries collapsed). IV from rolling vol (no iv_history): 16.
Entry dates 2025-06-02 … 2026-08-10.

Genuine >35% moves KEPT in the sample (3): CGNX 2026-02-12 (36%); ORCL 2025-09-10 (36%); SNPS 2025-09-10 (-36%)

Quoted slippage (intraday quotes only): 124 tickers with ≥3 quotes — 124 from intraday, 0 from after-close. Rows read: briefCandidatesIntraday 819, briefCandidatesAfterClose 1040, spreadChainsIntraday 16237, spreadChainsAfterClose 23240, premiumHistoryAfterClose 66857. Per leg: p10 $0.025 · median $0.150 · p90 $0.725. Entries priced from quotes: 468 of 1495; the rest use the $0 fallback.

ret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.

## 1. Draft profile — 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| episodes | 479 | 71.8 | 3.11 | 10.43 | **0.307** | 10.1 | T63 S7 H30 E0 | 84.6 | 0.65 | 0.95 | **0.073** | 8.9 |
| pooled (every replay day) | 1494 | 71.4 | 2.66 | 9.78 | **0.256** | 10.4 | T63 S7 H31 E0 | 83.7 | 0.61 | 0.96 | **0.066** | 9.3 |

Tails (episodes): spread p5 -43.5% / worst $-2410 per contract; CSP p5 -3.3% / worst $-11643. Avg P&L per contract: spread $15, CSP $103.
Credit as % of width (5%-of-spot wing): p10 13 · p25 16 · median 19 · p75 21 · p90 24.
Round-trip cost (4 leg-fills) as % of mid credit: p10 0 · p25 0 · median 0 · p75 9 · p90 50.
IV rank at entry (episodes with a rank, 287): <30 2 · 30–50 1 · 50–80 47 · ≥80 237

## 2. Exit grid (30d Δ0.25 w5% skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts10 | 479 | 64.3 | 1.06 | 6.46 | **0.143** | 7.4 | T46 S16 H39 E0 | 75.8 | 0.51 | 0.79 | **0.073** | 7.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts15 | 479 | 69.1 | 1.88 | 10.22 | **0.209** | 9.0 | T60 S20 H21 E0 | 80.4 | 0.53 | 0.92 | **0.065** | 8.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts– | 479 | 74.1 | 2.15 | 12.10 | **0.211** | 10.2 | T74 S25 H0 E1 | 82.5 | 0.50 | 1.01 | **0.056** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts10 | 479 | 64.5 | 1.92 | 6.46 | **0.240** | 8.0 | T47 S4 H49 E0 | 76.6 | 0.59 | 0.79 | **0.081** | 7.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 71.8 | 3.11 | 10.43 | **0.307** | 10.1 | T63 S7 H30 E0 | 84.6 | 0.65 | 0.95 | **0.073** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts– | 479 | 82.7 | 4.01 | 12.90 | **0.326** | 12.3 | T84 S13 H0 E3 | 90.2 | 0.66 | 1.09 | **0.064** | 10.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts10 | 479 | 64.5 | 1.71 | 6.46 | **0.207** | 8.2 | T47 S0 H53 E0 | 76.6 | 0.58 | 0.79 | **0.078** | 7.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts15 | 479 | 72.0 | 3.17 | 10.43 | **0.299** | 10.6 | T63 S0 H37 E0 | 85.4 | 0.70 | 0.95 | **0.076** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 479 | 86.2 | 4.88 | 13.10 | **0.346** | 14.1 | T87 S0 H0 E13 | 93.9 | 0.86 | 1.11 | **0.075** | 11.5 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts10 | 479 | 62.6 | 1.35 | 6.44 | **0.155** | 8.7 | T25 S16 H59 E0 | 73.5 | 0.49 | 0.84 | **0.057** | 8.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts15 | 479 | 66.2 | 2.40 | 9.95 | **0.214** | 11.2 | T43 S21 H36 E0 | 77.2 | 0.54 | 1.10 | **0.049** | 10.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts– | 479 | 70.6 | 3.24 | 15.94 | **0.238** | 13.6 | T69 S29 H0 E2 | 78.3 | 0.58 | 1.35 | **0.045** | 13.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts10 | 479 | 62.8 | 2.32 | 6.44 | **0.247** | 9.4 | T25 S4 H71 E0 | 74.3 | 0.58 | 0.84 | **0.064** | 9.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts15 | 479 | 68.9 | 3.80 | 10.17 | **0.304** | 12.5 | T45 S7 H48 E0 | 81.4 | 0.67 | 1.11 | **0.057** | 11.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts– | 479 | 80.6 | 5.64 | 17.33 | **0.346** | 16.3 | T78 S15 H0 E7 | 86.6 | 0.79 | 1.44 | **0.053** | 14.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts10 | 479 | 62.8 | 2.11 | 6.44 | **0.219** | 9.6 | T25 S0 H75 E0 | 74.3 | 0.59 | 0.84 | **0.064** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts15 | 479 | 69.1 | 3.86 | 10.17 | **0.298** | 13.0 | T46 S0 H54 E0 | 82.3 | 0.74 | 1.11 | **0.061** | 12.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts– | 479 | 85.2 | 6.83 | 17.65 | **0.374** | 18.3 | T81 S0 H0 E19 | 90.6 | 1.01 | 1.48 | **0.062** | 16.4 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts10 | 479 | 62.6 | 1.49 | 6.31 | **0.153** | 9.7 | T0 S16 H84 E0 | 73.5 | 0.52 | 0.84 | **0.051** | 10.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts15 | 479 | 64.3 | 2.28 | 9.39 | **0.166** | 13.7 | T0 S21 H79 E0 | 76.2 | 0.57 | 1.09 | **0.040** | 14.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts– | 479 | 67.4 | 4.38 | 19.75 | **0.180** | 24.4 | T0 S31 H0 E69 | 74.9 | 0.71 | 1.59 | **0.027** | 25.9 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts10 | 479 | 62.8 | 2.46 | 6.33 | **0.237** | 10.4 | T0 S4 H96 E0 | 74.3 | 0.61 | 0.84 | **0.058** | 10.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts15 | 479 | 67.0 | 3.67 | 9.76 | **0.244** | 15.0 | T0 S7 H93 E0 | 80.4 | 0.71 | 1.11 | **0.047** | 15.2 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts– | 479 | 79.1 | 7.25 | 20.90 | **0.260** | 27.8 | T0 S16 H0 E84 | 84.1 | 0.94 | 1.73 | **0.033** | 28.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts10 | 479 | 62.8 | 2.25 | 6.33 | **0.212** | 10.6 | T0 S0 H100 E0 | 74.3 | 0.61 | 0.84 | **0.058** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts15 | 479 | 67.2 | 3.73 | 9.76 | **0.241** | 15.5 | T0 S0 H100 E0 | 81.2 | 0.77 | 1.12 | **0.050** | 15.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts– | 479 | 85.0 | 8.76 | 21.02 | **0.292** | 30.0 | T0 S0 H0 E100 | 88.1 | 1.17 | 1.74 | **0.039** | 30.0 |

## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew0 pt0.5 sl2 ts15 | 480 | 72.7 | 4.02 | 11.42 | **0.419** | 9.6 | T65 S7 H28 E0 | 82.7 | 0.57 | 0.92 | **0.069** | 8.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 71.8 | 3.11 | 10.43 | **0.307** | 10.1 | T63 S7 H30 E0 | 84.6 | 0.65 | 0.95 | **0.073** | 8.9 |
| 30d Δ0.25 w5.0% skew6 pt0.5 sl2 ts15 | 479 | 70.6 | 2.01 | 8.77 | **0.191** | 10.6 | T61 S7 H31 E0 | 84.8 | 0.69 | 1.00 | **0.073** | 9.3 |

## 4. Entry DTE × short delta (draft exits, w5%, skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 21d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 474 | 80.0 | 2.85 | 8.41 | **0.380** | 7.5 | T80 S12 H8 E0 | 89.9 | 0.48 | 0.68 | **0.069** | 6.9 |
| 21d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 78.9 | 3.62 | 11.01 | **0.433** | 8.3 | T77 S11 H13 E0 | 87.5 | 0.54 | 0.87 | **0.074** | 7.3 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 480 | 76.0 | 4.24 | 13.39 | **0.469** | 9.0 | T73 S10 H18 E0 | 86.7 | 0.69 | 1.04 | **0.087** | 7.9 |
| 30d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 476 | 73.5 | 2.37 | 7.87 | **0.252** | 9.4 | T66 S9 H25 E0 | 86.6 | 0.57 | 0.79 | **0.068** | 8.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 71.8 | 3.11 | 10.43 | **0.307** | 10.1 | T63 S7 H30 E0 | 84.6 | 0.65 | 0.95 | **0.073** | 8.9 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 480 | 69.2 | 3.81 | 12.32 | **0.352** | 10.8 | T59 S5 H36 E0 | 82.9 | 0.80 | 1.17 | **0.085** | 9.4 |
| 35d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 477 | 71.5 | 2.63 | 7.73 | **0.263** | 10.0 | T63 S7 H30 E0 | 84.5 | 0.60 | 0.83 | **0.067** | 9.0 |
| 35d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 70.1 | 3.23 | 9.79 | **0.301** | 10.7 | T59 S5 H36 E0 | 82.9 | 0.64 | 1.00 | **0.068** | 9.5 |
| 35d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 480 | 67.3 | 3.65 | 11.21 | **0.321** | 11.4 | T54 S4 H42 E0 | 81.0 | 0.78 | 1.22 | **0.078** | 9.9 |

## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 479 | 86.2 | 4.88 | 13.10 | **0.346** | 14.1 | T87 S0 H0 E13 | 93.9 | 0.86 | 1.11 | **0.075** | 11.5 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– | 480 | 89.6 | 5.30 | 10.80 | **0.402** | 13.2 | T89 S0 H0 E11 | 94.0 | 0.86 | 1.11 | **0.075** | 11.5 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– | 480 | 91.3 | 4.91 | 9.30 | **0.385** | 12.8 | T90 S0 H0 E10 | 94.0 | 0.86 | 1.11 | **0.075** | 11.5 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | 480 | 84.8 | 5.80 | 16.85 | **0.380** | 15.3 | T84 S0 H0 E16 | 90.6 | 0.96 | 1.38 | **0.077** | 12.5 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– | 480 | 87.5 | 5.95 | 14.46 | **0.412** | 14.5 | T86 S0 H0 E14 | 90.6 | 0.96 | 1.38 | **0.077** | 12.5 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | 480 | 88.3 | 5.55 | 12.16 | **0.398** | 13.9 | T86 S0 H0 E14 | 90.6 | 0.96 | 1.38 | **0.077** | 12.5 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– | 480 | 81.9 | 5.10 | 20.10 | **0.313** | 16.3 | T79 S0 H0 E21 | 87.7 | 1.02 | 1.63 | **0.076** | 13.5 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– | 480 | 85.2 | 6.18 | 17.24 | **0.403** | 15.3 | T82 S0 H0 E18 | 87.7 | 1.02 | 1.63 | **0.076** | 13.5 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– | 480 | 86.7 | 6.57 | 14.78 | **0.442** | 14.9 | T83 S0 H0 E17 | 87.7 | 1.02 | 1.63 | **0.076** | 13.5 |

## 4c. Same grid, liquid entries only — round-trip cost (open + close, both legs) ≤ 25% of the mid credit

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 392 | 90.3 | 6.84 | 14.16 | **0.492** | 13.9 | T87 S0 H0 E13 | 94.4 | 0.93 | 1.16 | **0.081** | 11.5 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 404 | 92.1 | 6.74 | 11.71 | **0.517** | 13.0 | T90 S0 H0 E10 | 94.6 | 0.95 | 1.16 | **0.083** | 11.4 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 414 | 92.8 | 5.86 | 9.99 | **0.463** | 12.6 | T90 S0 H0 E10 | 94.4 | 0.95 | 1.17 | **0.082** | 11.5 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 400 | 86.8 | 7.59 | 18.46 | **0.502** | 15.1 | T85 S0 H0 E16 | 90.5 | 1.01 | 1.41 | **0.079** | 12.7 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 418 | 88.3 | 7.02 | 15.15 | **0.490** | 14.3 | T86 S0 H0 E14 | 90.7 | 1.04 | 1.43 | **0.082** | 12.6 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 430 | 88.8 | 6.43 | 12.78 | **0.466** | 13.8 | T87 S0 H0 E13 | 90.9 | 1.05 | 1.44 | **0.083** | 12.5 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 411 | 82.5 | 6.52 | 21.76 | **0.402** | 16.2 | T78 S0 H0 E22 | 87.6 | 1.06 | 1.63 | **0.078** | 13.5 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 432 | 85.6 | 7.46 | 18.55 | **0.495** | 15.1 | T82 S0 H0 E18 | 88.0 | 1.11 | 1.64 | **0.083** | 13.4 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 441 | 87.1 | 7.49 | 15.33 | **0.513** | 14.6 | T84 S0 H0 E16 | 88.0 | 1.10 | 1.64 | **0.083** | 13.3 |

## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| credit ≥ 20% of width | 177 | 77.4 | 6.86 | 15.45 | **0.664** | 10.3 | T65 S4 H31 E0 | 84.2 | 1.05 | 1.49 | **0.115** | 9.1 |
| credit < 20% of width | 302 | 68.5 | 0.92 | 7.92 | **0.091** | 10.0 | T62 S9 H29 E0 | 84.8 | 0.42 | 0.80 | **0.047** | 8.8 |
| round-trip cost ≤ 25% of credit | 392 | 77.0 | 5.22 | 11.77 | **0.513** | 10.2 | T64 S5 H31 E0 | 84.2 | 0.71 | 0.99 | **0.079** | 9.0 |
| round-trip cost 25–50% of credit | 40 | 65.0 | 1.36 | 5.59 | **0.129** | 10.6 | T63 S3 H35 E0 | 90.0 | 0.91 | 1.03 | **0.104** | 8.8 |
| round-trip cost > 50% of credit | 47 | 34.0 | -12.94 | -6.05 | **-1.355** | 9.6 | T55 S23 H21 E0 | 83.0 | -0.07 | 0.74 | **-0.008** | 8.4 |
| IV rank ≥ 30 | 285 | 73.7 | 4.28 | 11.27 | **0.436** | 9.8 | T67 S5 H28 E0 | 85.3 | 0.87 | 1.07 | **0.102** | 8.4 |
| IV rank < 30 | 2 | 50.0 | 1.29 | 9.69 | **0.074** | 17.5 | T50 S0 H50 E0 | 50.0 | -1.01 | 0.41 | **-0.084** | 12.0 |
| IV rank unknown | 192 | 69.3 | 1.40 | 8.12 | **0.133** | 10.6 | T57 S9 H33 E0 | 83.9 | 0.35 | 0.81 | **0.036** | 9.6 |
| close above SMA50 | 411 | 70.6 | 2.43 | 10.22 | **0.239** | 10.2 | T63 S8 H30 E0 | 84.2 | 0.60 | 0.94 | **0.067** | 8.9 |
| close below SMA50 | 68 | 79.4 | 7.22 | 11.70 | **0.729** | 9.9 | T65 S3 H32 E0 | 86.8 | 0.97 | 1.00 | **0.107** | 9.0 |
| quoted slip ≤ $0.03/leg | 14 | 42.9 | -3.17 | -1.27 | **-0.255** | 12.4 | T43 S14 H43 E0 | 92.9 | 0.74 | 0.89 | **0.080** | 9.2 |
| quoted slip > $0.03/leg | 109 | 53.2 | -4.70 | 1.69 | **-0.467** | 10.1 | T61 S12 H28 E0 | 82.6 | 0.39 | 0.85 | **0.045** | 8.9 |
| no quotes (fallback slip) | 356 | 78.7 | 5.75 | 12.17 | **0.570** | 10.1 | T65 S5 H30 E0 | 84.8 | 0.73 | 1.00 | **0.081** | 8.9 |

## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 2025-Q2 | 33 | 72.7 | 4.43 | 8.78 | **0.404** | 11.0 | T61 S3 H36 E0 | 87.9 | 0.49 | 0.66 | **0.047** | 10.3 |
| 2025-Q3 | 116 | 69.8 | -0.90 | 8.12 | **-0.088** | 10.2 | T56 S13 H31 E0 | 78.4 | 0.08 | 0.84 | **0.009** | 9.3 |
| 2025-Q4 | 97 | 78.4 | 8.23 | 11.48 | **0.874** | 9.4 | T69 S3 H28 E0 | 94.8 | 1.14 | 1.09 | **0.140** | 8.1 |
| 2026-Q1 | 102 | 66.7 | -0.27 | 8.89 | **-0.026** | 10.4 | T62 S10 H28 E0 | 80.4 | 0.45 | 0.90 | **0.052** | 8.8 |
| 2026-Q2 | 85 | 75.3 | 5.50 | 11.12 | **0.529** | 10.4 | T68 S2 H29 E0 | 87.1 | 1.07 | 1.18 | **0.116** | 9.2 |
| 2026-Q3 | 46 | 67.4 | 4.59 | 12.13 | **0.464** | 9.9 | T63 S4 H33 E0 | 80.4 | 0.84 | 1.30 | **0.100** | 8.4 |

## 7. Portfolio — $25,000 pot, every replay day in pick-rank order, one position per ticker, ≤ 10 open
Spread sized to ≤ $2500 max loss per position; CSP to ≤ 25% of the pot in cash per position. P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, capital = no free cash, dup = ticker already open, full = position cap.

on deployed % = total P&L ÷ average capital in use. Gated rows (cost≤) filter BOTH columns to the same liquid entries.

| config | SPREAD final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full |
|---|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | $58,366 | **133.5** | 99.2 | 168.1 | $7,458 (26.4%) | 414 | 79 | 51/0/574/455 | $29,714 | **18.9** | 15.1 | 48.4 | $329 (1.2%) | 113 | 39 | 1181/4/196/0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | $52,781 | **111.1** | 80.0 | 138.6 | $9,894 (20.5%) | 304 | 80 | 35/0/364/791 | $30,778 | **23.1** | 17.8 | 50.6 | $367 (1.4%) | 104 | 46 | 1181/7/202/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $66,227 | **164.9** | 115.2 | 199.9 | $8,697 (21.8%) | 292 | 83 | 37/0/364/802 | $31,702 | **26.8** | 20.5 | 56.2 | $367 (1.4%) | 101 | 48 | 1186/9/199/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | $69,502 | **178.0** | 123.5 | 257.4 | $4,218 (7.8%) | 298 | 69 | 190/0/446/561 | $31,702 | **26.8** | 20.5 | 56.2 | $367 (1.4%) | 101 | 48 | 1186/9/199/0 |
| 30d Δ0.3 w5.0% skew3 pt0.75 sl– ts– | $82,147 | **228.6** | 154.9 | 274.4 | $9,668 (13.4%) | 232 | 83 | 30/0/300/933 | $31,416 | **25.7** | 19.7 | 45.9 | $887 (3.1%) | 81 | 56 | 1187/17/210/0 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $81,239 | **225.0** | 157.4 | 274.4 | $7,994 (18.4%) | 398 | 82 | 47/0/493/557 | $31,136 | **24.5** | 19.3 | 57.2 | $257 (1.0%) | 117 | 43 | 1188/1/189/0 |
| 30d Δ0.3 w5.0% skew3 pt– sl– ts– | $56,497 | **126.0** | 89.9 | 150.2 | $5,338 (10.3%) | 146 | 84 | 20/0/149/1180 | $30,018 | **20.1** | 15.5 | 27.6 | $444 (1.6%) | 59 | 73 | 1184/42/210/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | $68,822 | **175.3** | 121.8 | 221.8 | $10,147 (14.8%) | 279 | 79 | 47/0/407/526 | $31,068 | **24.3** | 18.6 | 54.4 | $367 (1.4%) | 94 | 45 | 986/7/172/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | $72,246 | **189.0** | 130.4 | 283.4 | $4,218 (7.0%) | 290 | 67 | 200/0/476/403 | $31,394 | **25.6** | 19.6 | 55.1 | $367 (1.4%) | 98 | 46 | 1080/7/184/0 |

## 8. Ranking within the day (BPS-10) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25%, top 5 of each day's eligible set

lift = mean return of the chosen 5 minus the mean of that day's whole eligible set, averaged over days. The null band is 500 random choices of 5 on the same days. p = share of random choices that did at least as well.

skew 3: no day had more than 5 eligible candidates — the cut never binds here.
skew 0: no day had more than 5 eligible candidates — the cut never binds here.
skew 6: no day had more than 5 eligible candidates — the cut never binds here.

64 configurations were compared in §2–4c and 9 in §7; expect the best to look better than it is. Prefer a setting that is good across neighbours over the single top row.
