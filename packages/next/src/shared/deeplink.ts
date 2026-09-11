/**
 * The deep-link grammar — 05 §11.1.
 *
 * `tradeanalyzer-next://exceptions?run=<run_id>`   the workbench, filtered to a run (the status email's link)
 * `tradeanalyzer-next://exceptions/<exception_id>` one exception
 * `tradeanalyzer-next://runs/<run_id>`             one run
 * `tradeanalyzer-next://table/<table_name>`        the inspector on a table (`?as_of=` is accepted and carried)
 *
 * **A link may only navigate.** The return type has no way to express an
 * action — there is no route that resolves, queues, cancels or resets — so a
 * link an email can be made to carry is a link that can at most change which
 * screen is showing. That is the whole security argument, and keeping it in
 * the type is what stops a later route from quietly weakening it.
 *
 * Pure, and in `shared/` so a test can hold it to the grammar without Electron.
 */

export const DEEP_LINK_SCHEME = 'tradeanalyzer-next';

export type DeepLinkRoute =
  | { readonly section: 'exceptions'; readonly runId?: number; readonly exceptionId?: number }
  | { readonly section: 'runs'; readonly runId?: number }
  | { readonly section: 'data'; readonly table: string; readonly asOf?: string }
  /** Anything unrecognised lands on Overview with the reason, never silently (05 §11.1). */
  | { readonly section: 'overview'; readonly problem: string };

const POSITIVE_INT = /^[1-9]\d{0,11}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function unknown(raw: string, why: string): DeepLinkRoute {
  return { section: 'overview', problem: `Could not open ${raw.slice(0, 200)} — ${why}.` };
}

/**
 * Parses one link. `isKnownTable` is the dictionary's allow-list, supplied by
 * the caller: a table link naming anything the dictionary does not declare is
 * refused here rather than handed to a view to fail on.
 */
export function parseDeepLink(raw: string, isKnownTable: (table: string) => boolean): DeepLinkRoute {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return unknown(raw, 'it is not a well-formed link');
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return unknown(raw, `it is not a ${DEEP_LINK_SCHEME}:// link`);

  // For a non-special scheme, `scheme://exceptions/12` puts `exceptions` in the
  // host and `/12` in the path. Trailing slashes are forgiven; anything deeper
  // than one segment is not part of the grammar.
  const target = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length > 1) return unknown(raw, 'it has more path than the grammar allows');
  const id = segments[0];

  switch (target) {
    case 'exceptions': {
      if (id !== undefined) {
        return POSITIVE_INT.test(id)
          ? { section: 'exceptions', exceptionId: Number(id) }
          : unknown(raw, `"${id}" is not an exception id`);
      }
      const run = url.searchParams.get('run');
      if (run === null) return { section: 'exceptions' };
      return POSITIVE_INT.test(run)
        ? { section: 'exceptions', runId: Number(run) }
        : unknown(raw, `"${run}" is not a run id`);
    }
    case 'runs': {
      if (id === undefined) return { section: 'runs' };
      return POSITIVE_INT.test(id) ? { section: 'runs', runId: Number(id) } : unknown(raw, `"${id}" is not a run id`);
    }
    case 'table': {
      if (id === undefined) return unknown(raw, 'it names no table');
      const name = decodeURIComponent(id);
      if (!isKnownTable(name)) return unknown(raw, `the dictionary declares no table "${name}"`);
      const asOf = url.searchParams.get('as_of');
      if (asOf !== null && !ISO_DATE.test(asOf)) return unknown(raw, `"${asOf}" is not a date`);
      return asOf === null ? { section: 'data', table: name } : { section: 'data', table: name, asOf };
    }
    default:
      return unknown(raw, `"${target}" is not a screen this app has`);
  }
}

/**
 * Finds the link in a process's arguments.
 *
 * On Windows a clicked link starts a SECOND instance with the URL in `argv`,
 * and the single-instance lock hands that `argv` to the first one — so this
 * runs over both the startup arguments and every `second-instance` event. The
 * case-insensitive match is deliberate: Windows passes the scheme through the
 * registry, and it is not guaranteed to preserve case.
 */
export function findDeepLink(argv: readonly string[]): string | undefined {
  const prefix = `${DEEP_LINK_SCHEME}://`;
  return argv.find((a) => a.toLowerCase().startsWith(prefix));
}

/**
 * The one-shot kinds the Jobs view may queue.
 *
 * Not `reset`, which the new exe executes itself (04 §7.6) and so never queues.
 * `replay` joined at B9b, once captures started recording the recipe each
 * response was parsed with — before that, a replay would have had to guess.
 * The main process refuses anything else, so a renderer bug cannot put a kind
 * on the queue that no host will run or that the wrong host would.
 */
export const QUEUEABLE_KINDS = ['universe_seed', 'backfill_bars', 'bootstrap_iv', 'legacy_import', 'replay'] as const;
export type QueueableKind = (typeof QUEUEABLE_KINDS)[number];

export function isQueueableKind(kind: string): kind is QueueableKind {
  return (QUEUEABLE_KINDS as readonly string[]).includes(kind);
}
