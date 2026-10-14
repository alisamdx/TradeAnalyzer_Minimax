# Bull put spread vs CSP — wheel replay entries (prices to 2026-10-13, slip: quoted per ticker (0.5 × median half-spread, intraday quotes), fallback $0.03/leg)

Replay picks 1495 → unsettled 0, no bars 0, excluded as split 0 / ticker reuse 0, usable 1495 → **480 episodes** (1015 repeat entries collapsed). IV from rolling vol (no iv_history): 16.
Entry dates 2025-06-02 … 2026-08-10.

Genuine >35% moves KEPT in the sample (3): CGNX 2026-02-12 (36%); ORCL 2025-09-10 (36%); SNPS 2025-09-10 (-36%)

Quoted slippage (intraday quotes only): 182 tickers with ≥3 quotes — 182 from intraday, 0 from after-close. Rows read: briefCandidatesIntraday 1533, briefCandidatesAfterClose 1763, spreadChainsIntraday 59167, spreadChainsAfterClose 65316, premiumHistoryAfterClose 78789. Per leg: p10 $0.023 · median $0.138 · p90 $0.675. Entries priced from quotes: 660 of 1495; the rest use the $0.03 fallback.

ret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.

## 1. Draft profile — 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| episodes | 479 | 66.4 | -0.27 | 6.47 | **-0.026** | 10.4 | T62 S8 H30 E0 | 82.9 | 0.58 | 0.88 | **0.065** | 9.0 |
| pooled (every replay day) | 1491 | 65.9 | -0.51 | 6.46 | **-0.048** | 10.7 | T61 S8 H32 E0 | 82.7 | 0.55 | 0.89 | **0.059** | 9.3 |

Tails (episodes): spread p5 -44.1% / worst $-2422 per contract; CSP p5 -3.2% / worst $-11649. Avg P&L per contract: spread $-3, CSP $95.
Credit as % of width (5%-of-spot wing): p10 12 · p25 15 · median 17 · p75 20 · p90 23.
Round-trip cost (4 leg-fills) as % of mid credit: p10 3 · p25 6 · median 17 · p75 38 · p90 70.
IV rank at entry (episodes with a rank, 287): <30 2 · 30–50 1 · 50–80 47 · ≥80 237

## 2. Exit grid (30d Δ0.25 w5% skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts10 | 479 | 57.4 | -2.20 | 2.64 | **-0.291** | 7.6 | T44 S17 H39 E0 | 74.1 | 0.45 | 0.75 | **0.064** | 7.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts15 | 479 | 63.7 | -1.42 | 6.06 | **-0.155** | 9.1 | T58 S22 H20 E0 | 79.1 | 0.48 | 0.86 | **0.058** | 8.2 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl1 ts– | 479 | 69.3 | -1.58 | 8.69 | **-0.154** | 10.2 | T71 S28 H0 E1 | 81.2 | 0.40 | 0.94 | **0.044** | 8.9 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts10 | 479 | 58.0 | -1.31 | 2.96 | **-0.160** | 8.2 | T45 S5 H50 E0 | 74.9 | 0.52 | 0.75 | **0.071** | 7.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 66.4 | -0.27 | 6.47 | **-0.026** | 10.4 | T62 S8 H30 E0 | 82.9 | 0.58 | 0.88 | **0.065** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts– | 479 | 80.0 | 0.54 | 9.78 | **0.043** | 12.5 | T82 S15 H0 E3 | 89.6 | 0.59 | 1.04 | **0.057** | 10.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts10 | 479 | 58.0 | -1.59 | 2.96 | **-0.188** | 8.5 | T45 S0 H55 E0 | 74.9 | 0.51 | 0.75 | **0.068** | 7.5 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts15 | 479 | 66.6 | -0.14 | 6.49 | **-0.013** | 10.9 | T62 S0 H38 E0 | 83.9 | 0.63 | 0.88 | **0.068** | 9.3 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 479 | 84.1 | 1.58 | 10.18 | **0.107** | 14.7 | T86 S0 H0 E14 | 93.7 | 0.79 | 1.06 | **0.068** | 11.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts10 | 479 | 55.7 | -2.00 | 2.22 | **-0.228** | 8.8 | T23 S18 H60 E0 | 72.0 | 0.43 | 0.76 | **0.049** | 8.7 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts15 | 479 | 61.4 | -1.09 | 5.93 | **-0.097** | 11.3 | T41 S23 H36 E0 | 75.6 | 0.48 | 1.04 | **0.044** | 10.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl1 ts– | 479 | 66.8 | -0.68 | 11.60 | **-0.051** | 13.5 | T66 S32 H0 E2 | 77.5 | 0.49 | 1.30 | **0.037** | 13.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts10 | 479 | 56.4 | -1.06 | 2.30 | **-0.112** | 9.5 | T23 S5 H72 E0 | 72.9 | 0.50 | 0.76 | **0.055** | 9.0 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts15 | 479 | 64.1 | 0.21 | 6.22 | **0.017** | 12.6 | T43 S9 H48 E0 | 79.3 | 0.59 | 1.05 | **0.051** | 11.8 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl2 ts– | 479 | 79.7 | 2.27 | 13.08 | **0.139** | 16.3 | T77 S17 H0 E6 | 86.4 | 0.72 | 1.38 | **0.048** | 14.9 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts10 | 479 | 56.4 | -1.34 | 2.30 | **-0.138** | 9.7 | T23 S0 H77 E0 | 72.9 | 0.51 | 0.76 | **0.056** | 9.2 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts15 | 479 | 64.3 | 0.35 | 6.22 | **0.026** | 13.2 | T43 S0 H57 E0 | 80.4 | 0.67 | 1.07 | **0.055** | 12.1 |
| 30d Δ0.25 w5.0% skew3 pt0.75 sl– ts– | 479 | 85.8 | 3.90 | 13.68 | **0.209** | 18.6 | T81 S0 H0 E19 | 90.6 | 0.95 | 1.39 | **0.057** | 16.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts10 | 479 | 55.7 | -1.88 | 2.27 | **-0.194** | 9.7 | T0 S18 H82 E0 | 72.0 | 0.45 | 0.76 | **0.045** | 10.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts15 | 479 | 60.1 | -1.19 | 4.89 | **-0.088** | 13.6 | T0 S23 H77 E0 | 74.3 | 0.51 | 1.04 | **0.036** | 14.3 |
| 30d Δ0.25 w5.0% skew3 pt– sl1 ts– | 479 | 64.5 | 1.41 | 17.24 | **0.059** | 23.8 | T0 S34 H0 E66 | 74.1 | 0.63 | 1.55 | **0.024** | 25.8 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts10 | 479 | 56.4 | -0.94 | 2.48 | **-0.090** | 10.4 | T0 S5 H95 E0 | 72.9 | 0.53 | 0.76 | **0.050** | 10.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts15 | 479 | 62.8 | 0.11 | 5.72 | **0.008** | 15.0 | T0 S9 H91 E0 | 78.1 | 0.62 | 1.05 | **0.041** | 15.1 |
| 30d Δ0.25 w5.0% skew3 pt– sl2 ts– | 479 | 77.7 | 4.87 | 18.61 | **0.177** | 27.5 | T0 S18 H0 E82 | 83.9 | 0.90 | 1.69 | **0.032** | 28.2 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts10 | 479 | 56.4 | -1.22 | 2.48 | **-0.114** | 10.6 | T0 S0 H100 E0 | 72.9 | 0.54 | 0.76 | **0.051** | 10.6 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts15 | 479 | 63.0 | 0.25 | 5.93 | **0.016** | 15.5 | T0 S0 H100 E0 | 79.1 | 0.70 | 1.06 | **0.045** | 15.5 |
| 30d Δ0.25 w5.0% skew3 pt– sl– ts– | 479 | 84.6 | 6.87 | 18.81 | **0.229** | 30.0 | T0 S0 H0 E100 | 88.1 | 1.13 | 1.71 | **0.038** | 30.0 |

## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew0 pt0.5 sl2 ts15 | 479 | 69.5 | 0.56 | 8.02 | **0.057** | 9.8 | T64 S8 H28 E0 | 82.3 | 0.50 | 0.84 | **0.059** | 8.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 66.4 | -0.27 | 6.47 | **-0.026** | 10.4 | T62 S8 H30 E0 | 82.9 | 0.58 | 0.88 | **0.065** | 9.0 |
| 30d Δ0.25 w5.0% skew6 pt0.5 sl2 ts15 | 479 | 62.8 | -1.15 | 5.08 | **-0.104** | 11.0 | T58 S8 H34 E0 | 83.7 | 0.62 | 0.93 | **0.065** | 9.4 |

## 4. Entry DTE × short delta (draft exits, w5%, skew3)

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 21d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 472 | 73.1 | -0.11 | 5.59 | **-0.014** | 7.9 | T78 S14 H8 E0 | 89.6 | 0.41 | 0.63 | **0.058** | 7.0 |
| 21d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 477 | 75.1 | 0.43 | 8.03 | **0.049** | 8.7 | T75 S12 H13 E0 | 87.4 | 0.49 | 0.81 | **0.065** | 7.4 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 73.9 | 0.91 | 10.12 | **0.097** | 9.4 | T71 S11 H19 E0 | 86.4 | 0.63 | 0.98 | **0.079** | 8.0 |
| 30d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 475 | 66.3 | -0.47 | 4.78 | **-0.049** | 9.7 | T65 S10 H25 E0 | 84.4 | 0.49 | 0.72 | **0.058** | 8.4 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 66.4 | -0.27 | 6.47 | **-0.026** | 10.4 | T62 S8 H30 E0 | 82.9 | 0.58 | 0.88 | **0.065** | 9.0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 65.3 | 0.08 | 8.95 | **0.007** | 11.0 | T57 S7 H36 E0 | 81.2 | 0.71 | 1.12 | **0.076** | 9.4 |
| 35d Δ0.2 w5.0% skew3 pt0.5 sl2 ts15 | 476 | 63.0 | -0.66 | 4.28 | **-0.064** | 10.4 | T60 S9 H32 E0 | 83.4 | 0.54 | 0.76 | **0.060** | 9.0 |
| 35d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 64.3 | -0.45 | 6.61 | **-0.041** | 10.9 | T56 S8 H37 E0 | 81.4 | 0.58 | 0.95 | **0.061** | 9.5 |
| 35d Δ0.3 w5.0% skew3 pt0.5 sl2 ts15 | 479 | 62.0 | -0.15 | 7.34 | **-0.013** | 11.6 | T51 S5 H43 E0 | 80.4 | 0.71 | 1.17 | **0.071** | 9.9 |

## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | 479 | 84.1 | 1.58 | 10.18 | **0.107** | 14.7 | T86 S0 H0 E14 | 93.7 | 0.79 | 1.06 | **0.068** | 11.7 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– | 479 | 89.4 | 3.09 | 8.84 | **0.228** | 13.6 | T89 S0 H0 E11 | 93.7 | 0.79 | 1.06 | **0.068** | 11.7 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– | 480 | 91.0 | 3.63 | 7.76 | **0.279** | 13.0 | T90 S0 H0 E10 | 93.8 | 0.79 | 1.06 | **0.068** | 11.7 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | 479 | 85.2 | 2.61 | 13.71 | **0.166** | 15.7 | T83 S0 H0 E17 | 90.4 | 0.90 | 1.33 | **0.071** | 12.7 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– | 479 | 87.3 | 3.94 | 12.39 | **0.265** | 14.8 | T85 S0 H0 E15 | 90.4 | 0.90 | 1.33 | **0.071** | 12.7 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | 480 | 87.5 | 4.01 | 10.78 | **0.282** | 14.2 | T85 S0 H0 E15 | 90.4 | 0.90 | 1.33 | **0.071** | 12.7 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– | 479 | 82.3 | 2.13 | 16.89 | **0.128** | 16.7 | T78 S0 H0 E22 | 87.5 | 0.96 | 1.58 | **0.071** | 13.6 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– | 480 | 85.0 | 4.10 | 15.40 | **0.260** | 15.8 | T81 S0 H0 E19 | 87.5 | 0.96 | 1.58 | **0.071** | 13.6 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– | 480 | 86.3 | 4.87 | 13.50 | **0.323** | 15.1 | T83 S0 H0 E18 | 87.5 | 0.96 | 1.58 | **0.071** | 13.6 |

## 4c. Same grid, liquid entries only — round-trip cost (open + close, both legs) ≤ 25% of the mid credit

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 290 | 88.3 | 3.16 | 12.90 | **0.213** | 14.8 | T85 S0 H0 E15 | 93.1 | 0.76 | 1.12 | **0.063** | 12.1 |
| 30d Δ0.25 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 341 | 90.6 | 3.88 | 10.44 | **0.283** | 13.7 | T88 S0 H0 E12 | 93.5 | 0.82 | 1.09 | **0.069** | 11.8 |
| 30d Δ0.25 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 368 | 92.1 | 4.40 | 8.90 | **0.340** | 13.0 | T90 S0 H0 E10 | 93.8 | 0.84 | 1.09 | **0.072** | 11.7 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 323 | 85.8 | 4.54 | 16.04 | **0.293** | 15.5 | T84 S0 H0 E16 | 89.5 | 0.84 | 1.35 | **0.064** | 13.0 |
| 30d Δ0.3 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 368 | 87.8 | 4.97 | 13.75 | **0.339** | 14.7 | T86 S0 H0 E14 | 89.9 | 0.92 | 1.38 | **0.071** | 12.8 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 392 | 88.0 | 4.69 | 11.72 | **0.334** | 14.1 | T86 S0 H0 E14 | 90.1 | 0.93 | 1.38 | **0.073** | 12.7 |
| 30d Δ0.35 w5.0% skew3 pt0.5 sl– ts– cost≤25% | 350 | 81.7 | 3.08 | 19.32 | **0.185** | 16.7 | T78 S0 H0 E22 | 86.6 | 0.87 | 1.58 | **0.063** | 13.9 |
| 30d Δ0.35 w7.5% skew3 pt0.5 sl– ts– cost≤25% | 393 | 84.7 | 4.79 | 16.50 | **0.307** | 15.6 | T81 S0 H0 E19 | 87.0 | 0.99 | 1.61 | **0.073** | 13.6 |
| 30d Δ0.35 w10.0% skew3 pt0.5 sl– ts– cost≤25% | 412 | 86.7 | 5.62 | 14.15 | **0.378** | 14.9 | T83 S0 H0 E17 | 87.4 | 0.98 | 1.62 | **0.072** | 13.5 |

## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| credit ≥ 20% of width | 116 | 69.0 | 1.64 | 13.77 | **0.149** | 11.0 | T59 S7 H34 E0 | 80.2 | 0.93 | 1.52 | **0.095** | 9.8 |
| credit < 20% of width | 363 | 65.6 | -0.89 | 5.31 | **-0.087** | 10.2 | T62 S9 H29 E0 | 83.7 | 0.47 | 0.81 | **0.054** | 8.7 |
| round-trip cost ≤ 25% of credit | 290 | 73.8 | 2.32 | 10.18 | **0.218** | 10.7 | T62 S7 H31 E0 | 83.1 | 0.59 | 0.96 | **0.062** | 9.4 |
| round-trip cost 25–50% of credit | 100 | 67.0 | 0.68 | 6.28 | **0.068** | 9.9 | T64 S5 H31 E0 | 85.0 | 0.88 | 0.85 | **0.108** | 8.2 |
| round-trip cost > 50% of credit | 89 | 41.6 | -9.81 | -1.85 | **-0.974** | 10.1 | T57 S17 H26 E0 | 79.8 | 0.22 | 0.74 | **0.026** | 8.4 |
| IV rank ≥ 30 | 285 | 69.5 | 1.57 | 7.85 | **0.156** | 10.1 | T66 S6 H28 E0 | 83.9 | 0.80 | 1.03 | **0.094** | 8.5 |
| IV rank < 30 | 2 | 0.0 | -27.36 | -19.72 | **-4.209** | 6.5 | T0 S100 H0 E0 | 0.0 | -2.00 | -1.34 | **-0.267** | 7.5 |
| IV rank unknown | 192 | 62.5 | -2.73 | 4.24 | **-0.251** | 10.9 | T55 S11 H33 E0 | 82.3 | 0.28 | 0.77 | **0.029** | 9.6 |
| close above SMA50 | 411 | 65.5 | -0.94 | 5.91 | **-0.090** | 10.4 | T61 S9 H29 E0 | 82.5 | 0.53 | 0.86 | **0.059** | 9.0 |
| close below SMA50 | 68 | 72.1 | 3.73 | 8.66 | **0.356** | 10.5 | T63 S1 H35 E0 | 85.3 | 0.89 | 0.91 | **0.098** | 9.1 |
| quoted slip ≤ $0.03/leg | 22 | 59.1 | 1.96 | 9.05 | **0.166** | 11.8 | T55 S9 H36 E0 | 95.5 | 0.92 | 1.01 | **0.102** | 9.0 |
| quoted slip > $0.03/leg | 157 | 52.9 | -5.05 | 1.25 | **-0.483** | 10.5 | T59 S11 H30 E0 | 79.6 | 0.43 | 0.85 | **0.048** | 9.1 |
| no quotes (fallback slip) | 300 | 74.0 | 2.06 | 9.30 | **0.201** | 10.3 | T63 S7 H30 E0 | 83.7 | 0.63 | 0.90 | **0.071** | 8.9 |

## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| 2025-Q2 | 33 | 63.6 | 0.81 | 4.44 | **0.068** | 11.9 | T61 S3 H36 E0 | 84.8 | 0.41 | 0.55 | **0.039** | 10.4 |
| 2025-Q3 | 116 | 61.2 | -5.93 | 3.47 | **-0.573** | 10.4 | T53 S17 H30 E0 | 77.6 | 0.01 | 0.80 | **0.001** | 9.4 |
| 2025-Q4 | 97 | 74.2 | 4.79 | 6.97 | **0.479** | 10.0 | T68 S2 H30 E0 | 92.8 | 1.07 | 1.06 | **0.128** | 8.3 |
| 2026-Q1 | 102 | 63.7 | -1.45 | 7.01 | **-0.139** | 10.4 | T63 S11 H26 E0 | 79.4 | 0.38 | 0.85 | **0.044** | 8.8 |
| 2026-Q2 | 85 | 70.6 | 1.67 | 9.51 | **0.160** | 10.4 | T65 S5 H31 E0 | 83.5 | 0.99 | 1.16 | **0.108** | 9.1 |
| 2026-Q3 | 46 | 63.0 | 1.56 | 8.15 | **0.154** | 10.1 | T63 S4 H33 E0 | 80.4 | 0.80 | 1.29 | **0.094** | 8.5 |

## 7. Portfolio — $25,000 pot, every replay day in pick-rank order, one position per ticker, ≤ 10 open
Spread sized to ≤ $2500 max loss per position; CSP to ≤ 25% of the pot in cash per position. P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, capital = no free cash, dup = ticker already open, full = position cap.

on deployed % = total P&L ÷ average capital in use. Gated rows (cost≤) filter BOTH columns to the same liquid entries.

| config | SPREAD final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | on deployed % | max DD | trades | util % | skipped size/cap/dup/full |
|---|--:|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 30d Δ0.25 w5.0% skew3 pt0.5 sl2 ts15 | $18,897 | **-24.4** | -20.3 | -34.0 | $12,488 (46.7%) | 392 | 72 | 51/58/573/417 | $28,988 | **16.0** | 12.8 | 39.9 | $341 (1.3%) | 116 | 40 | 1180/4/191/0 |
| 30d Δ0.25 w5.0% skew3 pt0.5 sl– ts– | $35,760 | **43.0** | 32.5 | 54.2 | $10,236 (25.0%) | 300 | 79 | 36/0/372/783 | $29,979 | **19.9** | 15.4 | 43.2 | $370 (1.4%) | 104 | 46 | 1180/9/198/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $50,500 | **102.0** | 73.9 | 123.5 | $12,344 (24.2%) | 283 | 83 | 37/0/347/826 | $31,376 | **25.5** | 19.6 | 53.4 | $370 (1.4%) | 101 | 48 | 1184/9/199/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– | $56,748 | **127.0** | 90.6 | 182.3 | $4,936 (16.6%) | 295 | 70 | 204/0/461/535 | $31,376 | **25.5** | 19.6 | 53.4 | $370 (1.4%) | 101 | 48 | 1186/9/199/0 |
| 30d Δ0.3 w5.0% skew3 pt0.75 sl– ts– | $54,391 | **117.6** | 84.3 | 141.5 | $8,410 (16.7%) | 221 | 83 | 28/0/270/974 | $30,667 | **22.7** | 17.4 | 42.4 | $895 (3.2%) | 78 | 54 | 1185/17/213/0 |
| 21d Δ0.3 w5.0% skew3 pt0.5 sl– ts– | $36,007 | **44.0** | 34.0 | 54.2 | $14,841 (33.6%) | 378 | 81 | 46/0/472/596 | $30,464 | **21.9** | 17.2 | 52.4 | $272 (1.1%) | 114 | 42 | 1187/2/189/0 |
| 30d Δ0.3 w5.0% skew3 pt– sl– ts– | $50,763 | **103.1** | 74.6 | 121.9 | $5,436 (11.2%) | 146 | 85 | 20/0/149/1178 | $29,832 | **19.3** | 14.9 | 26.5 | $447 (1.6%) | 59 | 73 | 1182/42/210/0 |
| 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25% | $47,194 | **88.8** | 64.8 | 123.1 | $12,751 (23.8%) | 257 | 72 | 55/0/371/342 | $28,130 | **12.5** | 9.7 | 40.1 | $510 (2.0%) | 60 | 31 | 862/2/101/0 |
| 30d Δ0.3 w10.0% skew3 pt0.5 sl– ts– cost≤25% | $58,705 | **134.8** | 95.7 | 212.6 | $4,386 (8.6%) | 275 | 63 | 205/0/430/321 | $30,729 | **22.9** | 17.6 | 53.1 | $370 (1.4%) | 93 | 43 | 969/4/165/0 |

## 8. Ranking within the day (BPS-10) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– cost≤25%, top 5 of each day's eligible set

lift = mean return of the chosen 5 minus the mean of that day's whole eligible set, averaged over days. The null band is 500 random choices of 5 on the same days. p = share of random choices that did at least as well.

skew 3: no day had more than 5 eligible candidates — the cut never binds here.
skew 0: no day had more than 5 eligible candidates — the cut never binds here.
skew 6: no day had more than 5 eligible candidates — the cut never binds here.

## 9. Cost-gate sweep (BPS-9) — 30d Δ0.3 w5.0% skew3 pt0.5 sl– ts– with round-trip cost ≤ X% of mid credit

Fallback slip $0.03/leg for entries without quotes. Each row keeps the entries whose spread clears the gate; the CSP columns are the SAME entries.

| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |
|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|
| no gate — all (479/479 pass) | 479 | 85.2 | 2.61 | 13.71 | **0.166** | 15.7 | T83 S0 H0 E17 | 90.4 | 0.90 | 1.33 | **0.071** | 12.7 |
| cost ≤ 40% — all (384/479 pass) | 384 | 85.4 | 3.62 | 15.19 | **0.232** | 15.6 | T83 S0 H0 E17 | 89.3 | 0.89 | 1.35 | **0.069** | 13.0 |
| cost ≤ 35% — all (371/479 pass) | 371 | 85.7 | 3.85 | 15.39 | **0.246** | 15.6 | T83 S0 H0 E17 | 89.5 | 0.87 | 1.35 | **0.067** | 13.1 |
| cost ≤ 30% — all (359/479 pass) | 359 | 86.4 | 4.44 | 15.43 | **0.286** | 15.5 | T84 S0 H0 E16 | 89.7 | 0.84 | 1.34 | **0.064** | 13.0 |
| cost ≤ 25% — all (323/479 pass) | 323 | 85.8 | 4.54 | 16.04 | **0.293** | 15.5 | T84 S0 H0 E16 | 89.5 | 0.84 | 1.35 | **0.064** | 13.0 |
| cost ≤ 20% — all (285/479 pass) | 285 | 86.3 | 5.82 | 16.57 | **0.376** | 15.5 | T84 S0 H0 E16 | 90.2 | 0.92 | 1.38 | **0.070** | 13.1 |
| cost ≤ 15% — all (243/479 pass) | 243 | 86.4 | 5.80 | 16.73 | **0.381** | 15.2 | T84 S0 H0 E16 | 89.7 | 0.91 | 1.38 | **0.071** | 12.8 |
| no gate — quoted only (179/179) | 179 | 81.6 | -2.06 | 9.00 | **-0.123** | 16.7 | T82 S0 H0 E18 | 89.9 | 0.72 | 1.28 | **0.057** | 12.6 |
| cost ≤ 40% — quoted only (94/179) | 94 | 79.8 | -2.07 | 13.21 | **-0.121** | 17.2 | T79 S0 H0 E21 | 86.2 | 0.58 | 1.38 | **0.043** | 13.6 |
| cost ≤ 35% — quoted only (85/179) | 85 | 81.2 | -1.23 | 13.52 | **-0.073** | 16.8 | T80 S0 H0 E20 | 87.1 | 0.60 | 1.39 | **0.044** | 13.4 |
| cost ≤ 30% — quoted only (76/179) | 76 | 84.2 | 1.60 | 14.95 | **0.099** | 16.3 | T83 S0 H0 E17 | 88.2 | 0.54 | 1.38 | **0.041** | 13.1 |
| cost ≤ 25% — quoted only (62/179) | 62 | 83.9 | 2.34 | 16.71 | **0.141** | 16.6 | T82 S0 H0 E18 | 88.7 | 0.49 | 1.35 | **0.037** | 13.1 |
| cost ≤ 20% — quoted only (49/179) | 49 | 87.8 | 8.20 | 18.14 | **0.510** | 16.1 | T86 S0 H0 E14 | 91.8 | 0.80 | 1.54 | **0.062** | 13.1 |
| cost ≤ 15% — quoted only (32/179) | 32 | 87.5 | 8.13 | 20.78 | **0.536** | 15.2 | T88 S0 H0 E13 | 90.6 | 0.98 | 1.64 | **0.084** | 11.7 |

Portfolio, same pot and sizing as §7, every replay day:

| gate | SPREAD final | return % | ann. % | max DD | trades | CSP final | return % | max DD | trades |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| none | $50,500 | **102.0** | 73.9 | $12,344 (24.2%) | 283 | $31,376 | **25.5** | $370 (1.4%) | 101 |
| ≤ 40% | $53,812 | **115.2** | 82.8 | $13,712 (23.4%) | 273 | $30,666 | **22.7** | $370 (1.4%) | 91 |
| ≤ 35% | $47,055 | **88.2** | 64.5 | $11,924 (21.3%) | 269 | $29,540 | **18.2** | $408 (1.6%) | 85 |
| ≤ 30% | $48,171 | **92.7** | 67.5 | $11,059 (18.7%) | 261 | $28,891 | **15.6** | $374 (1.5%) | 80 |
| ≤ 25% | $47,194 | **88.8** | 64.8 | $12,751 (23.8%) | 257 | $28,130 | **12.5** | $510 (2.0%) | 60 |
| ≤ 20% | $50,994 | **104.0** | 75.2 | $12,091 (22.2%) | 228 | $27,315 | **9.3** | $166 (0.6%) | 27 |
| ≤ 15% | $46,761 | **87.0** | 66.4 | $11,880 (23.1%) | 206 | $25,000 | **0.0** | $0 (0.0%) | 0 |

Read: a gate earns its level if tightening it improves the spread's mean and tail on the QUOTED rows without emptying the sample; a flat or noisy curve means the level is a judgement call, not a finding.

78 configurations were compared in §2–4c and §9, and 16 portfolios in §7 and §9; expect the best to look better than it is. Prefer a setting that is good across neighbours over the single top row.
