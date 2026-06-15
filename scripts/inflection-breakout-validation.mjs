// Validation v2: breakout/continuation ranking + credit-spread survival + IV overlay.
// Q: after a decisive (top-quintile) breakout, does a directional credit spread anchored
// beyond the level expire OTM (keep the credit), and does requiring rich IV hurt it?
// Pure stock-move test on historical_prices. see scripts/inflection-breakout-validation.mjs
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const tickers = db.prepare(
  "SELECT DISTINCT ticker FROM constituents WHERE index_name IN ('sp500','russell1000')"
).all().map(r => r.ticker);

// ── Precompute IV rank (trailing-252 percentile of atm_iv) per ticker/date ──────
const ivRankByTicker = new Map(); // ticker → Map(date → ivRank 0..100)
{
  const rows = db.prepare('SELECT ticker, date, atm_iv FROM iv_history WHERE atm_iv IS NOT NULL ORDER BY ticker, date').all();
  let cur = null, arr = [];
  const flush = (t) => {
    if (!t) return;
    const m = new Map();
    for (let i = 0; i < arr.length; i++) {
      const w = arr.slice(Math.max(0, i - 251), i + 1).map(x => x.atm_iv);
      if (w.length >= 30) {
        const mn = Math.min(...w), mx = Math.max(...w);
        m.set(arr[i].date, mx > mn ? ((arr[i].atm_iv - mn) / (mx - mn)) * 100 : 50);
      }
    }
    ivRankByTicker.set(t, m);
  };
  for (const r of rows) { if (r.ticker !== cur) { flush(cur); cur = r.ticker; arr = []; } arr.push(r); }
  flush(cur);
}
function ivRankAt(ticker, date) {
  const m = ivRankByTicker.get(ticker); if (!m) return null;
  if (m.has(date)) return m.get(date);
  // nearest earlier date
  let best = null;
  for (const [d, v] of m) { if (d <= date) best = v; else break; }
  return best;
}

const getBars = db.prepare('SELECT date, high, low, close, volume FROM historical_prices WHERE ticker = ? ORDER BY date');
const events = [];

for (const ticker of tickers) {
  const bars = getBars.all(ticker);
  if (bars.length < 80) continue;
  const close = bars.map(b => b.close), high = bars.map(b => b.high), low = bars.map(b => b.low), vol = bars.map(b => b.volume);
  const tr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) tr[i] = Math.max(high[i]-low[i], Math.abs(high[i]-close[i-1]), Math.abs(low[i]-close[i-1]));
  const atr = new Array(bars.length).fill(null);
  for (let i = 14; i < bars.length; i++) atr[i] = tr.slice(i-13, i+1).reduce((a,b)=>a+b,0)/14;

  for (let i = 50; i < bars.length - 10; i++) {
    const prior20High = Math.max(...high.slice(i-20, i));
    const prior20Low  = Math.min(...low.slice(i-20, i));
    const a = atr[i]; if (!a) continue;
    const vol20 = vol.slice(i-20, i).reduce((x,y)=>x+y,0)/20;
    const sma50 = close.slice(i-49, i+1).reduce((x,y)=>x+y,0)/50;
    const up = close[i] > prior20High && close[i-1] <= prior20High;
    const down = close[i] < prior20Low && close[i-1] >= prior20Low;
    if (!up && !down) continue;
    const withTrend = up ? close[i] > sma50 : close[i] < sma50;
    if (!withTrend) continue;

    const level = up ? prior20High : prior20Low;
    events.push({
      dir: up ? 'up' : 'down', ticker, date: bars[i].date,
      decisiveness: Math.abs(close[i]-level)/a, volRatio: vol20>0?vol[i]/vol20:1, atrPct:(a/close[i])*100,
      level, atr: a, c0: close[i], c5: close[i+5],
      ret5: (up?1:-1)*(close[i+5]-close[i])/close[i]*100,
      ivRank: ivRankAt(ticker, bars[i].date),
    });
  }
}

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const pct = (n,d) => d ? (n/d*100) : NaN;
console.log(`Breakout events: ${events.length} (up ${events.filter(e=>e.dir==='up').length}, down ${events.filter(e=>e.dir==='down').length})`);
console.log(`IV rank coverage: ${pct(events.filter(e=>e.ivRank!=null).length, events.length).toFixed(0)}% of events have an IV rank`);

// Credit-spread expiry win: short strike placed `cushion` ATR beyond the level.
//   bull put (up):  short strike Ks = level − cushion·ATR ; win if c5 ≥ Ks
//   bear call (down): short strike Ks = level + cushion·ATR ; win if c5 ≤ Ks
function spreadWin(e, cushion) {
  const Ks = e.dir === 'up' ? e.level - cushion*e.atr : e.level + cushion*e.atr;
  return e.dir === 'up' ? e.c5 >= Ks : e.c5 <= Ks;
}

for (const dir of ['up','down']) {
  const ev = events.filter(e => e.dir === dir);
  // composite z-score
  const feats = ['decisiveness','volRatio','atrPct'];
  const st = {};
  for (const f of feats){ const v=ev.map(e=>e[f]); const m=mean(v); const sd=Math.sqrt(mean(v.map(x=>(x-m)**2)))||1; st[f]={m,sd}; }
  ev.forEach(e=> e.composite = feats.reduce((s,f)=>s+(e[f]-st[f].m)/st[f].sd,0));
  const sorted = [...ev].sort((a,b)=>b.composite-a.composite);
  const top = sorted.slice(0, Math.floor(sorted.length/5)); // Q5

  console.log(`\n── ${dir.toUpperCase()} — TOP-QUINTILE breakouts (n=${top.length}) ──`);
  console.log(`  5d continuation: avg ${mean(top.map(e=>e.ret5)).toFixed(2)}%`);
  console.log(`  credit-spread win (expire OTM) by short-strike cushion beyond level:`);
  for (const c of [0, 0.5, 1.0, 1.5]) {
    console.log(`    Ks = level ${dir==='up'?'−':'+'} ${c}·ATR:  win ${pct(top.filter(e=>spreadWin(e,c)).length, top.length).toFixed(1)}%`);
  }
  // IV overlay on top quintile (richer premium = the population we'd actually sell)
  const withIv = top.filter(e => e.ivRank != null);
  const hi = withIv.filter(e => e.ivRank >= 50), lo = withIv.filter(e => e.ivRank < 50);
  const winAt1 = arr => pct(arr.filter(e=>spreadWin(e,1.0)).length, arr.length);
  console.log(`  IV overlay (top quintile, 1·ATR cushion):`);
  console.log(`    high IV rank ≥50 (n=${hi.length}): win ${winAt1(hi).toFixed(1)}%  | low IV <50 (n=${lo.length}): win ${winAt1(lo).toFixed(1)}%`);
}

db.close();
