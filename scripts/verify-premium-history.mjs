// One-off verification of the first DailyOptionsPremiumHistoryJob run.
// Opens the live DB write-capable (NOT readonly) so the WAL index attaches and
// recent writes are visible. see CLAUDE.md "Live-DB inspection".
import Database from 'better-sqlite3';

const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
console.log(`Today (ET): ${today}\n`);

// 1. Overall shape ─────────────────────────────────────────────────────────────
const overall = db.prepare(`
  SELECT COUNT(*) rows, COUNT(DISTINCT as_of_date) dates,
         MIN(as_of_date) from_d, MAX(as_of_date) to_d
  FROM options_premium_history
`).get();
console.log('── Overall ──');
console.log(`rows=${overall.rows}  dates=${overall.dates}  range ${overall.from_d} → ${overall.to_d}\n`);

// 2. By strategy, latest date ───────────────────────────────────────────────────
console.log('── By strategy (most recent capture date) ──');
const byStrat = db.prepare(`
  SELECT strategy, COUNT(*) n,
         SUM(strike IS NULL) null_strike,
         SUM(premium IS NULL) null_premium,
         ROUND(AVG(premium), 2) avg_premium,
         ROUND(AVG(annualized_return), 1) avg_ann,
         SUM(delta IS NOT NULL) has_delta,
         SUM(open_interest IS NOT NULL) has_oi
  FROM options_premium_history
  WHERE as_of_date = (SELECT MAX(as_of_date) FROM options_premium_history)
  GROUP BY strategy
`).all();
console.table(byStrat);

// 3. Sanity sample (latest date) ────────────────────────────────────────────────
console.log('\n── Sample rows (latest date, 10 each strategy) ──');
for (const strat of ['wheel', 'income']) {
  const sample = db.prepare(`
    SELECT ticker, structure, last_price, strike, expiration, dte, delta, premium,
           annualized_return, iv, iv_rank, open_interest, breakeven
    FROM options_premium_history
    WHERE strategy = ? AND as_of_date = (SELECT MAX(as_of_date) FROM options_premium_history)
    ORDER BY ticker LIMIT 10
  `).all(strat);
  console.log(`\n  ${strat}:`);
  console.table(sample);
}

// 4. Red-flag checks ────────────────────────────────────────────────────────────
console.log('\n── Red-flag checks (latest date) ──');
const flags = db.prepare(`
  SELECT
    SUM(strike <= 0 OR strike IS NULL) bad_strike,
    SUM(premium <= 0 OR premium IS NULL) bad_premium,
    SUM(dte <= 0 OR dte IS NULL) bad_dte,
    SUM(strike > last_price * 3 OR strike < last_price * 0.3) strike_far_from_spot,
    SUM(annualized_return > 500) implausible_ann
  FROM options_premium_history
  WHERE as_of_date = (SELECT MAX(as_of_date) FROM options_premium_history)
`).get();
console.table([flags]);

// 5. Distinct tickers captured today vs expected universe size ───────────────────
const tickCount = db.prepare(`
  SELECT strategy, COUNT(DISTINCT ticker) tickers
  FROM options_premium_history
  WHERE as_of_date = (SELECT MAX(as_of_date) FROM options_premium_history)
  GROUP BY strategy
`).all();
console.log('\n── Distinct tickers (latest date) ──');
console.table(tickCount);

db.close();
