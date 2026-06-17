// FR-SEY-5 A/B validation for the computeADX fix — NOT a unit test (gated behind RUN_ADX_AB).
// Runs the real BriefReplayService over a date range on a COPY of the live DB, once with ADX
// off (pre-fix behaviour, REPLAY_NO_ADX) and once with ADX on, and compares per-strategy
// forward-return quality. Run explicitly:
//   RUN_ADX_AB=1 REPLAY_FROM=2025-05-01 REPLAY_TO=2026-06-15 npx vitest run adx-replay-validation
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScoringService } from '../src/main/services/scoring-service.js';
import { BriefReplayService } from '../src/main/services/brief-replay-service.js';

const LIVE = join(process.env.APPDATA ?? '', 'trade-analyzer', 'trade-analyzer.sqlite');
const FROM = process.env.REPLAY_FROM ?? '2026-06-01';
const TO   = process.env.REPLAY_TO   ?? '2026-06-15';

type Row = { strat: string; dir: number; r21: number };
function metrics(db: Database.Database): Record<string, { n: number; metric: number; hr: number }> {
  const rows = db.prepare(`
    SELECT rb.strategy strat, COALESCE(ro.direction, CASE WHEN rb.strategy='bearish' THEN -1 ELSE 1 END) dir, ro.ret_21d r21
    FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
    WHERE ro.ret_21d IS NOT NULL
  `).all() as Row[];
  const out: Record<string, { n: number; metric: number; hr: number }> = {};
  for (const s of ['bullish', 'bearish', 'buy', 'income', 'wheel', 'inflection']) {
    const r = rows.filter(x => x.strat === s);
    if (!r.length) continue;
    // income: smaller absolute move is better; others: direction-adjusted return.
    const m = r.map(x => s === 'income' ? Math.abs(x.r21) : x.dir * x.r21);
    const wins = r.filter(x => s === 'income' ? Math.abs(x.r21) < 8 : x.dir * x.r21 > 0).length;
    out[s] = { n: r.length, metric: m.reduce((a, b) => a + b, 0) / m.length, hr: (wins / r.length) * 100 };
  }
  return out;
}

describe.runIf(process.env.RUN_ADX_AB)('ADX fix — FR-SEY-5 replay A/B', () => {
  it('compares ADX-off vs ADX-on pick quality on a copy of the live DB', async () => {
    const tmp = join(tmpdir(), `ta-adx-ab-${Date.now()}.sqlite`);
    for (const ext of ['', '-wal', '-shm']) if (existsSync(LIVE + ext)) copyFileSync(LIVE + ext, tmp + ext);
    const db = new Database(tmp);
    const replay = new BriefReplayService(db, new ScoringService(db));
    const noop = () => {};
    const sig = new AbortController().signal;

    // OFF arm = default (no ADX in scoring, = shipped behaviour); ON arm = REPLAY_WITH_ADX.
    delete process.env.REPLAY_WITH_ADX;
    await replay.runRange(FROM, TO, noop, sig);
    const before = metrics(db);

    process.env.REPLAY_WITH_ADX = '1';
    await replay.runRange(FROM, TO, noop, sig);
    const after = metrics(db);
    delete process.env.REPLAY_WITH_ADX;

    console.log(`\n========== ADX A/B  (${FROM} .. ${TO}) ==========`);
    console.log('strategy     n     metric: OFF -> ON  (delta)        HR: OFF -> ON');
    for (const s of Object.keys(after)) {
      const b = before[s], a = after[s];
      if (!b || !a) continue;
      const dir = s === 'income' ? 'lower=better' : 'higher=better';
      console.log(
        `${s.padEnd(11)} ${String(a.n).padStart(4)}  ` +
        `${b.metric.toFixed(2).padStart(6)} -> ${a.metric.toFixed(2).padStart(6)}  ` +
        `(${(a.metric - b.metric >= 0 ? '+' : '') + (a.metric - b.metric).toFixed(2)}pp)  ${dir}   ` +
        `HR ${b.hr.toFixed(0)}% -> ${a.hr.toFixed(0)}%`,
      );
    }

    db.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(tmp + ext, { force: true });
    expect(after).toBeDefined();
  }, 45 * 60 * 1000);
});
