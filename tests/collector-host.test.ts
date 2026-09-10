import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `ElectronCollectorHost` adapter — NewApp 06 §7, 04 §1.1.
 *
 * These are source assertions rather than a live harness. The adapter's whole
 * job is to hand `core` the existing app's hardened transports, and the
 * properties worth pinning are exactly the ones that were expensive to learn and
 * are invisible at runtime until the day they bite: renew-and-retry on ANY
 * failure, a write-capable database handle, and account data never written in
 * the clear. A mock-based test would restate the code; these restate the
 * lessons.
 */

/**
 * Strips comments before scanning.
 *
 * Third time today this has been needed — `core`'s purity guard, `next`'s AC-13
 * scan, and now this. A source assertion that reads comments fires on its own
 * documentation, and the rule it teaches is "stop explaining the rule".
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SRC = join(process.cwd(), 'src', 'main');
const host = stripComments(readFileSync(join(SRC, 'collector-host', 'electron-collector-host.ts'), 'utf8'));
const oneshot = stripComments(readFileSync(join(SRC, 'services', 'jobs', 'collector-oneshot.ts'), 'utf8'));
const daily = stripComments(readFileSync(join(SRC, 'services', 'jobs', 'collector-daily.ts'), 'utf8'));
const index = stripComments(readFileSync(join(SRC, 'index.ts'), 'utf8'));
const etradeAuth = stripComments(readFileSync(join(SRC, 'services', 'etrade-auth.ts'), 'utf8'));

describe('ElectronCollectorHost', () => {
  it('renews and retries on ANY E*Trade failure, never on an auth-shaped message', () => {
    // A dormant token does not reliably fail as a 401 — it can kill or hang the
    // response stream. That exact heuristic bit two separate paths in the
    // existing app, one of them halting the evening orchestrator on 8 of 10
    // trading days. Renewing an active token errors harmlessly, so the retry is
    // gated on "not 2xx" and nothing else.
    const retryBlock = host.slice(host.indexOf('async etradeGet('), host.indexOf('async httpGet('));
    expect(retryBlock).toContain('renewAccessToken');
    expect(retryBlock).toMatch(/status >= 200 && .*status < 300/);
    // No message sniffing anywhere in the decision.
    expect(retryBlock).not.toMatch(/token_expired|token_rejected|oauth_problem|\/401\//);
  });

  it('opens the generation write-capable, never readonly', () => {
    // On Windows a readonly connection cannot attach the live WAL index and
    // silently reads only up to the last checkpoint. The new exe holds this same
    // file open, so a readonly handle here would read a stale generation and
    // report it as current (CLAUDE.md).
    expect(host).toContain('new Database(dbPath)');
    expect(host).not.toMatch(/readonly:\s*true/);
    expect(host).toContain("journal_mode = WAL");
  });

  it('refuses to write account data unencrypted rather than falling back', () => {
    // The archive is permanent (04 §6), so a file written in the clear today
    // stays that way forever and there is no way to tell later which files
    // those were.
    const enc = host.slice(host.indexOf('encryptForArchive('), host.indexOf('decryptFromArchive('));
    expect(enc).toContain('isEncryptionAvailable');
    expect(enc).toMatch(/throw new Error/);
  });

  it('never invents the shared pointer', () => {
    // If it is missing, the new exe has not been run. Inventing a path would
    // create a second, empty generation indistinguishable from the real one
    // having lost its data.
    const reader = host.slice(host.indexOf('export function readSharedPointer'), host.indexOf('export function generationPaths'));
    expect(reader).not.toMatch(/writeFileSync|mkdirSync/);
    expect(reader).toContain('return undefined');
  });

  it('never creates a generation either — the pointer guard stopped one level short', () => {
    // `readSharedPointer` refuses to invent a pointer, but `new Database(path)`
    // CREATES the file when it is missing, so the 2-minute claim tick would
    // quietly manufacture a generation of its own. Observed 2026-09-07: minutes
    // after the corrupt gen-001 was deleted, the collector rebuilt it — 52
    // tables, `integrity_check: ok`, and **zero rows in `meta_generation`**,
    // because only the new exe writes that. It looks healthy from every angle
    // except the one that says whose it is.
    const opener = host.slice(host.indexOf('openGenerationDb()'), host.indexOf('close(): void'));
    // The refusal must come BEFORE both the directory creation and the open.
    const refusal = opener.indexOf('existsSync(dbPath)');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(opener.indexOf('mkdirSync'));
    expect(refusal).toBeLessThan(opener.indexOf('new Database(dbPath)'));
    expect(opener).toContain('belongs to TradeAnalyzer 2');
  });

  it('lets every caller report a missing generation rather than failing on it', () => {
    // The choke point throws so creation is impossible; the callers check first
    // so the operator sees `skipped` with a reason instead of a stack trace.
    // Patching one call site and leaving the others is the trap this project
    // keeps hitting, so every caller is asserted.
    //
    // There were four. `index.ts`'s 2-minute claim loop was the fourth and was
    // removed in v1.1.206 — it re-claimed a request whose terminal state could
    // not be written and emailed a RED gate report every two minutes. A caller
    // that no longer exists is the one way this list is allowed to shrink.
    expect(host).toContain('export function generationExists');
    expect(index).not.toContain("runJob('collector-oneshot'");
    for (const source of [oneshot, daily]) {
      expect(source).toContain('generationExists');
      expect(source).toContain('TradeAnalyzer 2 has not created one');
    }
  });

  it('gets its ET timestamp from core, not from its own copy', () => {
    // toISOString gives UTC, which silently shifts every evening timestamp onto
    // the following day — the class of bug that starved the agent of option
    // contracts for ten days.
    //
    // This used to assert an inline `America/New_York` build here, and it
    // passed while the NEW exe wrote `openedAt` with `toISOString()` into the
    // same forensic table, a day out. **A rule pinned against one
    // implementation does not constrain the second one.** Both now call
    // `etTimestamp` in `core`, and `packages/core/test/time.test.ts` is where
    // the behaviour itself is tested.
    const nowEt = host.slice(host.indexOf('nowET(): string'), host.indexOf('async sendEmail('));
    expect(nowEt).toContain('etTimestamp()');
    expect(nowEt).not.toContain('toISOString');
  });

  it('puts every Polygon call through the shared rate limiter, never a bare fetch', () => {
    // Polygon rate-limits per API key and the collector shares this app's key,
    // so two buckets would be two budgets spending one allowance. Hosting the
    // collector here was chosen precisely to avoid that (Q4: one token holder,
    // one limiter) — and `polygonGet` then called `fetch` directly from v1.1.196
    // to v1.1.211, which is the arrangement's whole premise unmet.
    const polygon = host.slice(host.indexOf('async polygonGet('), host.indexOf('async etradeGet('));
    expect(polygon).toContain('rateLimiter.acquire(1)');
    // Acquired before the latency clock starts, or a long queue wait is reported
    // as Polygon being slow — in the log that gets read first when a provider
    // path misbehaves.
    expect(polygon.indexOf('rateLimiter.acquire(1)')).toBeLessThan(polygon.indexOf('const started ='));
    // The limiter is the app's instance, handed in — not one this file builds,
    // which would be a second bucket wearing the right name.
    expect(host).not.toMatch(/new TokenBucketRateLimiter/);
  });

  it('reports the close-time checkpoint on success as well as on failure', () => {
    // v1.1.209 added the explicit `wal_checkpoint(TRUNCATE)` and logged it only
    // when it did NOT fully apply — which reproduces, one level up, the exact
    // ambiguity the checkpoint was added to remove. Silence then means either
    // "the checkpoint applied cleanly" or "`close()` was never reached", and a
    // seed that comes back clean reads as a fix confirmed under the first and
    // as no evidence at all under the second.
    const closeBlock = host.slice(host.indexOf('close(): void'), host.indexOf('archiveRoot(): string'));
    expect(closeBlock).toContain('wal_checkpoint(TRUNCATE)');
    // Logged every time, with the level carrying the verdict.
    expect(closeBlock).toMatch(/level:\s*healthy\s*\?\s*'INFO'\s*:\s*'WARNING'/);
    // An empty WAL is its own outcome, never folded into "applied". `log ===
    // checkpointed` is true of `0 === 0`, so without this the two clean seeds of
    // 2026-09-09 — 4.15 MB of WAL file, zero pending frames, twice — would have
    // read as a checkpoint that did the work, and the missing checkpoint would
    // have gone into the record as the fix for the corruption.
    expect(closeBlock).toMatch(/row\.log === 0/);
    expect(closeBlock).toContain('nothing to do');
    // Busy is distinct from short, too: one is contention, the other is loss.
    expect(closeBlock).toMatch(/row\.busy !== 0/);
    // The WAL size that preceded it, or the log line says nothing about scale:
    // a fully applied checkpoint over an empty WAL is not the same evidence.
    expect(closeBlock).toContain('walBytes');
    // A throw is a third outcome and must not collapse into the other two.
    expect(closeBlock).toMatch(/catch\s*\(err\)/);
    expect(closeBlock).toContain('checkpoint threw');
  });
});

describe('etradeGetRaw — the collector transport', () => {
  it('returns a non-2xx rather than throwing, because a failed call is evidence', () => {
    const raw = etradeAuth.slice(
      etradeAuth.indexOf('export async function etradeGetRaw'),
      etradeAuth.indexOf('export async function etradeGet(')
    );
    expect(raw).toContain('return { status: res.status, body');
    expect(raw).toMatch(/status: null[\s\S]*error:/); // a network fault has no status
  });

  it('keeps the logging asymmetry: failure bodies logged, success bodies never', () => {
    const raw = etradeAuth.slice(
      etradeAuth.indexOf('export async function etradeGetRaw'),
      etradeAuth.indexOf('export async function etradeGet(')
    );
    // The preview appears exactly once, inside the "not ok" branch of the
    // success log — never on the unconditional path.
    expect(raw).toContain('res.ok ? {} : {');
    const previews = raw.match(/responseBodyPreview/g) ?? [];
    expect(previews.length).toBe(2); // the nonce-retry log and the not-ok branch
    expect(raw.slice(raw.indexOf('res.ok ? {}'))).toContain('responseBodyPreview');
  });

  it('keeps the single nonce retry', () => {
    const raw = etradeAuth.slice(
      etradeAuth.indexOf('export async function etradeGetRaw'),
      etradeAuth.indexOf('export async function etradeGet(')
    );
    expect(raw).toContain('_isNonceRetry');
  });
});

describe('collector batch handlers', () => {
  it('claims exactly one job per tick', () => {
    // A loop draining the backlog would hold the batch mutex for as long as the
    // backlog took, and these jobs include backfill_bars at ~1,600 calls.
    expect(oneshot).toContain('claimNextJob');
    expect(oneshot).not.toMatch(/while\s*\(/);
  });

  it('fails an unimplemented job kind rather than leaving it claimed', () => {
    // A request that vanishes into `claimed` and never moves looks identical to
    // a crashed host.
    expect(oneshot).toContain('IMPLEMENTED');
    expect(oneshot).toMatch(/state: 'failed'[\s\S]*not implemented yet/);
  });

  it('implements backfill_bars and reports its red verdict as a success', () => {
    // The review queue a backfill opens IS the deliverable (04 §7.2) — the
    // operator has to rule on ticker-reuse candidates before the pilot's first
    // clean day counts. A failed job would say the collector broke.
    expect(oneshot).toContain("'backfill_bars'");
    const branch = oneshot.slice(oneshot.indexOf("request.runKind === 'backfill_bars'"));
    expect(branch).toContain("status: 'success'");
    expect(branch).toContain('reviewQueue.length');
  });

  it('expires stale acceptances before any job reports', () => {
    // Otherwise the email and the review queue describe what was outstanding
    // yesterday rather than what is outstanding now.
    //
    // Compared inside the function body, not across the file: the import list
    // mentions both names first, so a whole-file index comparison would pass or
    // fail on import order and say nothing about execution order.
    const body = oneshot.slice(oneshot.indexOf('const tradingDate = deps.todayET();'));
    expect(body.indexOf('expireAcceptances')).toBeGreaterThan(-1);
    expect(body.indexOf('expireAcceptances')).toBeLessThan(body.indexOf('runBackfillBars'));
  });

  it('treats a missing generation pointer as skipped, not failed', () => {
    for (const source of [oneshot, daily]) {
      expect(source).toContain('No generation pointer yet');
    }
  });

  it('has a watchdog that reports rather than re-running', () => {
    // A watchdog that quietly re-ran the job would turn "the collector did not
    // run" into "the collector ran late", and the second is much harder to
    // notice going wrong repeatedly.
    const watchdog = daily.slice(daily.indexOf('createCollectorWatchdogJob'));
    expect(watchdog).toContain("status: 'failed'");
    expect(watchdog).not.toContain('runDaily');
  });

  it('has a watchdog that writes not_run and sends the no-run email', () => {
    // A dead scheduler produces no run, therefore no gate, therefore no status
    // email. Silence is the failure it reports, and `not_run` is what makes the
    // gap a declared fact rather than an absence of rows.
    const watchdog = daily.slice(daily.indexOf('createCollectorWatchdogJob'));
    expect(watchdog).toContain('markNotRun');
    expect(watchdog).toContain('buildNoRunEmail');
    // The registry has to exist first — on a day nothing ran, nothing else
    // would have created it, and markNotRun writes one row per registered domain.
    expect(watchdog.indexOf('syncRegistry')).toBeLessThan(watchdog.indexOf('markNotRun'));
  });

  it('reports a red gate verdict as a successful run, not a failed job', () => {
    // The gate finding problems is the gate working. A failed job means the
    // collector could not complete, and conflating the two makes the batch
    // history unable to answer either question.
    const dailyJob = daily.slice(0, daily.indexOf('createCollectorWatchdogJob'));
    expect(dailyJob).toContain("status: report.phaseErrors.length > 0 ? 'failed' : 'success'");
  });
});

describe('the shared Polygon limiter', () => {
  it('is handed to the collector host, so both share one bucket', () => {
    const factory = index.slice(index.indexOf('const makeCollectorHost'), index.indexOf('const todayET'));
    expect(factory).toMatch(/rateLimiter,/);
  });

  it('is seeded from the stored setting, not from the hardcoded default', () => {
    // `setRate` was only ever called from the settings SAVE handler, so a
    // configured rate lasted until the next restart and then silently reverted
    // to the default — the app ran at a rate its own Settings screen did not
    // show. Harmless while every caller was a person clicking; not harmless once
    // the collector shares the bucket and budgets a nightly run against a pace.
    const construction = index.slice(
      index.indexOf('const storedRpm'),
      index.indexOf('const jobQueue')
    );
    expect(construction).toContain("'rateLimitRpm'");
    expect(construction).toContain('requestsPerMinute: storedRpm');
    // An unreadable or absent setting falls back rather than throwing: the
    // limiter sits on the path of every provider call and must never be the
    // reason the app fails to boot.
    expect(construction).toMatch(/Number\.isFinite/);
  });
});

describe('registration in the existing app', () => {
  it('registers the three collector jobs LAST, so no existing sequence_order moves', () => {
    // sequence_order is seeded from registration order and then frozen in the DB
    // (CLAUDE.md), so reordering only affects fresh installs — and a job added
    // in the middle would silently renumber nothing on this install while
    // renumbering everything on a new one.
    const collectorAt = index.indexOf("registerJob(\n    'data-collector'");
    const orchestratorAt = index.indexOf("registerJob('batch-orchestrator'");
    expect(collectorAt).toBeGreaterThan(0);
    expect(collectorAt).toBeLessThan(orchestratorAt);

    const existingJobs = [
      'daily-iv-update', 'constituents-refresh', 'daily-market-sync-stocks', 'daily-screener',
      'earnings-refresh', 'daily-intelligence-brief', 'portfolio-sync'
    ];
    for (const job of existingJobs) {
      expect(index.indexOf(`registerJob('${job}'`)).toBeLessThan(collectorAt);
    }
  });

  it('schedules the daily collector after this app\'s own after-close chain', () => {
    const block = index.slice(index.indexOf("'data-collector'"), index.indexOf("'collector-watchdog'"));
    expect(block).toContain("dailyScheduleTime: '17:05'");
    expect(block).toContain('afterCloseOnly: true');
  });

  it('registers all three collector jobs DISABLED — manual runs only', () => {
    // v1.1.206. Every automatic trigger is off: no daily schedule, no startup
    // run, and `enabled: false` keeps them out of the orchestrator chain, which
    // is the one that actually runs jobs twice a trading day.
    //
    // They stay registered on purpose. `runJob` never consulted `enabled`, so
    // the Batch view can still run them by hand — "off" means "does not run on
    // its own", not "cannot be run".
    const block = index.slice(
      index.indexOf("registerJob(\n    'data-collector'"),
      index.indexOf("registerJob('batch-orchestrator'")
    );
    expect(block.length).toBeGreaterThan(0);
    for (const id of ["'data-collector'", "'collector-watchdog'", "'collector-oneshot'"]) {
      expect(block, id).toContain(id);
    }
    expect(block.match(/enabled: false/g) ?? []).toHaveLength(3);
    expect(block.match(/dailyScheduleEnabled: false/g) ?? []).toHaveLength(3);
    expect(block.match(/runOnStartup: false/g) ?? []).toHaveLength(3);
  });

  it('has no automatic claim loop at all', () => {
    // The emitter. A claimed request whose `finishJob` write fails stays
    // `queued`, so the loop re-claimed it every two minutes, ran it, failed and
    // emailed — 70 runs and an inbox full of RED before the first could be
    // acted on. A retry over work that cannot record its own outcome does not
    // converge, and nothing bounded it.
    //
    // Asserted on the whole file, not on a block: a loop reintroduced anywhere
    // in boot has the same effect wherever it is written.
    //
    // Keyed on the collector run rather than on `setInterval`, because boot has
    // a legitimate one — the ~90-minute E*Trade keep-alive that stops the token
    // going dormant. A guard that banned the mechanism instead of the effect
    // would fire on that and teach the wrong lesson.
    expect(index).not.toContain("runJob('collector-oneshot'");
    expect(index).not.toContain('claim loop started');
    const keepAliveOnly = index.match(/setInterval/g) ?? [];
    expect(keepAliveOnly).toHaveLength(1);
    expect(index.slice(index.indexOf('setInterval') - 200, index.indexOf('setInterval'))).toContain(
      '_etradeKeepAlive'
    );
  });
});
