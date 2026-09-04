// BLAST RADIUS of v1.1.189's critic context — how many verdicts actually move?
//
// SKIPPED unless RUN_CRITIC_AB=1, because it makes REAL Anthropic calls (two per pick) against the
// live database. `npm test` skips it.
//
//   RUN_CRITIC_AB=1 npx vitest run tests/critic-context-ab.test.ts
//   RUN_CRITIC_AB=1 AB_LIMIT=20 npx vitest run tests/critic-context-ab.test.ts
//
// WHY IT LIVES IN tests/ RATHER THAN scripts/. It has to import `CriticService` to exercise the
// REAL prompt and context assembly — reimplementing them in a standalone script would test a copy,
// which is the one thing that cannot answer this question. That import resolves `@shared/*` path
// aliases, which plain `node` cannot do, so vitest is the only loader in this repo that can run it.
// (v1.1.189 first shipped this as `scripts/critic-context-ab.mjs`, which could not run for exactly
// that reason.)
//
// WHAT IT CANNOT DO, stated so nobody mistakes it for validation. The verdict is a HARD GATE, so
// this change alters which trades are taken — FR-SEY-5 territory, which asks for a replay showing
// the change is at worst neutral ON OUTCOMES. That replay is not constructible here, and the
// reason is arithmetic rather than effort: only picks whose expiry has settled can be scored, only
// a minority of verdicts flip at all, and the intersection of those two sets across one regime is
// a handful of trades. A return figure from that would have no power behind it — the exact trap
// recorded for the own-at-strike study (12 episodes in one 4-week window).
//
// So this measures the BLAST RADIUS, which IS answerable and is what an operator needs before
// shipping: how many verdicts move, in which direction, on which picks. A change that flips 2% of
// verdicts is a different proposition from one that flips 40%, whatever the outcome data says.
//
// Both arms are the SAME code path on the SAME picks and the SAME rule flags, differing only in
// CRITIC_CONTEXT_V2 — so nothing but the context can explain a difference.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CriticService } from '../src/main/services/critic-service.js';
import type { BriefPick, ScoringConfig, ScoringSignal } from '../src/shared/types.js';

const RUN = process.env['RUN_CRITIC_AB'] === '1';
const LIMIT = Number(process.env['AB_LIMIT'] ?? 20);
const STRATEGY = process.env['AB_STRATEGY'] ?? 'wheel';
const DB_PATH = process.env['AB_DB']
  ?? join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite');

const RANK: Record<string, number> = { pass: 0, caution: 1, flag: 2 };

describe('critic context A/B (v1.1.189)', () => {
  it.skipIf(!RUN)('measures how many verdicts the new context moves', { timeout: 30 * 60_000 }, async () => {
    // Write-capable on purpose: a readonly connection cannot attach the live WAL index on Windows
    // and silently reads only to the last checkpoint.  see CLAUDE.md
    const db = new Database(DB_PATH);
    const svc = new CriticService(db);

    // The operator's own key, from the app's settings — `anthropicApiKey` is not in
    // SENSITIVE_KEYS so it is stored in clear and needs no Electron safeStorage. Never printed.
    const keyRow = db.prepare(`SELECT value FROM settings WHERE key = 'anthropicApiKey'`)
      .get() as { value: string } | undefined;
    const apiKey = keyRow?.value ?? '';
    expect(apiKey, 'no anthropicApiKey in settings — set it in the app first').not.toBe('');

    const briefs = db.prepare(
      `SELECT generated_at, picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at DESC`,
    ).all(STRATEGY) as Array<{ generated_at: string; picks: string }>;

    const sample: Array<{ date: string; p: BriefPick }> = [];
    for (const b of briefs) {
      let ps: BriefPick[];
      try { ps = JSON.parse(b.picks) as BriefPick[]; } catch { continue; }
      for (const p of ps) {
        if (sample.length >= LIMIT) break;
        sample.push({ date: b.generated_at.slice(0, 10), p });
      }
      if (sample.length >= LIMIT) break;
    }

    const market = svc.getMarketContext();
    console.log(`\ncritic context A/B — ${STRATEGY} — ${sample.length} picks, ${sample.length * 2} API calls`);
    console.log(`arms differ ONLY in CRITIC_CONTEXT_V2; rule flags are computed once and shared\n`);

    /** Reconstruct the strategy config from the pick's own signals, so `checkCriticalSignalMissing`
     *  sees real weights. Shared by both arms, so it cannot bias the delta either way. */
    const configFor = (p: BriefPick): ScoringConfig => ({
      strategy: STRATEGY as ScoringConfig['strategy'],
      signals: Object.entries(p.signals ?? {}).map(([key, v]) => ({
        key, label: key, weight: v.weight, enabled: true,
      })) as unknown as ScoringSignal[],
      version: 'ab', updatedAt: '2026-01-01',
    });

    type Row = {
      date: string; ticker: string;
      before?: string; after?: string;
      beforeDegraded?: boolean; afterDegraded?: boolean;
      afterRationale?: string | null; error?: string;
    };
    const rows: Row[] = [];

    for (const { date, p } of sample) {
      try {
        // Rule flags are computed ONCE and handed to both arms: the rule layer is unchanged by
        // v1.1.189, so recomputing it per arm would only add noise.
        const flags = svc.runRuleChecks(p, STRATEGY, configFor(p), new Map(), market);

        process.env['CRITIC_CONTEXT_V2'] = '0';
        const before = await svc.synthesizeVerdict(p, STRATEGY, flags, apiKey, market);
        process.env['CRITIC_CONTEXT_V2'] = '1';
        const after = await svc.synthesizeVerdict(p, STRATEGY, flags, apiKey, market);

        rows.push({
          date, ticker: p.ticker, before: before.verdict, after: after.verdict,
          beforeDegraded: before.degraded === true, afterDegraded: after.degraded === true,
          afterRationale: after.rationale,
        });
        process.stdout.write('.');
      } catch (err) {
        rows.push({ date, ticker: p.ticker, error: err instanceof Error ? err.message : String(err) });
        process.stdout.write('x');
      }
    }
    delete process.env['CRITIC_CONTEXT_V2'];
    console.log('\n');

    const errored = rows.filter(r => r.error);
    const degraded = rows.filter(r => !r.error && (r.beforeDegraded || r.afterDegraded));
    const ok = rows.filter(r => !r.error && !r.beforeDegraded && !r.afterDegraded);
    const same = ok.filter(r => r.before === r.after);
    const stricter = ok.filter(r => RANK[r.after!]! > RANK[r.before!]!);
    const looser = ok.filter(r => RANK[r.after!]! < RANK[r.before!]!);

    console.log(`comparable: ${ok.length}   (${degraded.length} degraded — the LLM did not run, excluded; ${errored.length} errored)`);
    for (const e of errored.slice(0, 3)) console.log(`   error: ${e.ticker} ${e.error?.slice(0, 120)}`);
    if (ok.length > 0) {
      const pct = (n: number) => `${((100 * n) / ok.length).toFixed(0)}%`;
      console.log(`unchanged:  ${same.length} (${pct(same.length)})`);
      console.log(`STRICTER:   ${stricter.length} (${pct(stricter.length)})   <- picks the dice would now reject`);
      console.log(`looser:     ${looser.length} (${pct(looser.length)})`);

      const beforeCounts: Record<string, number> = {}, afterCounts: Record<string, number> = {};
      for (const r of ok) {
        beforeCounts[r.before!] = (beforeCounts[r.before!] ?? 0) + 1;
        afterCounts[r.after!] = (afterCounts[r.after!] ?? 0) + 1;
      }
      console.log(`\nverdict mix  before: ${JSON.stringify(beforeCounts)}`);
      console.log(`             after:  ${JSON.stringify(afterCounts)}`);

      if (stricter.length + looser.length > 0) {
        console.log(`\nverdicts that moved:`);
        for (const r of [...stricter, ...looser]) {
          console.log(`  ${r.date}  ${r.ticker.padEnd(6)} ${r.before} -> ${r.after}`);
          if (r.afterRationale) console.log(`      ${r.afterRationale.slice(0, 200)}`);
        }
      }
    }

    console.log(`\nReading this`);
    console.log(`• A BLAST RADIUS, not a validation: how much moved, not whether the moves were right.`);
    console.log(`• The LLM is non-deterministic, so a small number of flips is partly noise. Re-run`);
    console.log(`  before attributing any single flip to the context change.`);
    console.log(`• STRICTER is the operational number: the critic already passes only ~17% of picks`);
    console.log(`  and is the dice's largest rejector, so a big stricter count shrinks the hit rate.`);
    console.log(`• Roll back with CRITIC_CONTEXT_V2=0 — no rebuild needed.\n`);

    db.close();
    expect(rows.length).toBe(sample.length);
  });
});
