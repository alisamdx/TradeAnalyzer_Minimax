// Regression tests for direction-aware Brief Replay outcomes (v0.33.1).
// Inflection mixes long (up-breakout) and short (down-breakout) picks, so the win/return
// aggregation must use replay_outcomes.direction, not a single "stock up = win" rule.

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BriefReplayService } from '../src/main/services/brief-replay-service.js';
import { ScoringService } from '../src/main/services/scoring-service.js';

function seedInflection(db: ReturnType<typeof openDatabase>, picks: Array<{ ticker: string; dir: number; ret21: number }>) {
  const brief = db.prepare(
    `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES ('2026-01-05','inflection','[]','baseline_v3')`
  ).run();
  const id = brief.lastInsertRowid as number;
  const stmt = db.prepare(
    `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price, ret_5d, ret_10d, ret_21d, direction)
     VALUES (?, ?, ?, 70, 100, ?, ?, ?, ?)`
  );
  picks.forEach((p, i) => stmt.run(id, p.ticker, i + 1, p.ret21, p.ret21, p.ret21, p.dir));
}

describe('direction-aware inflection replay summary', () => {
  it('counts a down-pick that fell as a win and a down-pick that rose as a loss', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedInflection(db, [
      { ticker: 'UP_WIN',   dir: 1,  ret21: 5 },   // long, rose → win
      { ticker: 'DN_WIN',   dir: -1, ret21: -4 },  // short, fell → win
      { ticker: 'DN_LOSS',  dir: -1, ret21: 3 },   // short, rose → loss
    ]);
    const summary = new BriefReplayService(db, new ScoringService(db)).getSummaries()
      .find(s => s.strategy === 'inflection')!;
    // 2 of 3 win at 21d
    expect(summary.n21d).toBe(3);
    expect(summary.hitRate21d).toBeCloseTo(66.7, 0);
    // Direction-adjusted avg: (+5 + 4 + (-3)) / 3 = +2.0
    expect(summary.avgReturn21d).toBeCloseTo(2.0, 1);
    db.close();
  });

  it('still treats bearish (legacy, direction NULL) as stock-down = win via fallback', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const brief = db.prepare(
      `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES ('2026-01-05','bearish','[]','baseline_v3')`
    ).run();
    const id = brief.lastInsertRowid as number;
    // direction left NULL → fallback to strategy-implied (-1 for bearish)
    db.prepare(`INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price, ret_21d) VALUES (?, 'X', 1, 75, 100, -6)`).run(id);
    const summary = new BriefReplayService(db, new ScoringService(db)).getSummaries()
      .find(s => s.strategy === 'bearish')!;
    expect(summary.hitRate21d).toBe(100);     // stock fell 6% → bearish win
    expect(summary.avgReturn21d).toBeCloseTo(-6, 1); // raw return preserved for non-inflection
    db.close();
  });
});
