# TODO

## Data Fields Still Missing

### Beta
- **Status**: Not available from Polygon API
- **Issue**: Polygon's `/v3/reference/tickers/{ticker}` endpoint does not include beta coefficient
- **Impact**: Beta filter in screener defaults to 1.0 (neutral)
- **Options**:
  1. Compute beta from historical price data vs SPY (requires fetching price history)
  2. Use a third-party data source for beta
  3. Leave as null and document the limitation

### Free Cash Flow (FCF) / Capital Expenditures
- **Status**: Capital expenditures not consistently available in Polygon financials
- **Issue**: Polygon's `/vX/reference/financials` response has `net_cash_flow_from_operating_activities` but `capital_expenditures` field is often missing
- **Impact**: FCF calculation may be incomplete (only operating cash flow, minus unknown capex)
- **Current Behavior**: FCF will show operating cash flow value if capex is unavailable, which is an overestimate
- **Options**:
  1. Accept the limitation and show "OCF only" when capex is unavailable
  2. Estimate capex from investing cash flow section
  3. Mark FCF as null when capex is unavailable