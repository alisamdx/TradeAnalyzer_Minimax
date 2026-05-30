/**
 * PayoffService — CRUD for saved multi-leg payoff strategies.
 * see docs/formulas.md#payoff-visualizer
 */

import type { Database } from 'better-sqlite3';
import type { PayoffLeg, SavedPayoffStrategy } from '@shared/types.js';

export class PayoffService {
  save(db: Database, name: string, ticker: string | null, legs: PayoffLeg[]): SavedPayoffStrategy {
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO payoff_strategies (name, ticker, legs_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), ticker ?? null, JSON.stringify(legs), now);

    return {
      id:        info.lastInsertRowid as number,
      name:      name.trim(),
      ticker:    ticker ?? null,
      legs,
      createdAt: now,
    };
  }

  list(db: Database): SavedPayoffStrategy[] {
    const rows = db.prepare(
      'SELECT * FROM payoff_strategies ORDER BY created_at DESC'
    ).all() as Record<string, unknown>[];

    return rows.map(r => ({
      id:        r['id'] as number,
      name:      r['name'] as string,
      ticker:    (r['ticker'] as string | null) ?? null,
      legs:      JSON.parse((r['legs_json'] as string | null) ?? '[]') as PayoffLeg[],
      createdAt: r['created_at'] as string,
    }));
  }

  delete(db: Database, id: number): void {
    db.prepare('DELETE FROM payoff_strategies WHERE id = ?').run(id);
  }
}
