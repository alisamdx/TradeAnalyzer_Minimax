import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A read-only window onto a closed generation must refuse every write (05 §8).
 * The refusal lives in `handleWrite`, so a write registered with plain `handle`
 * would run in that window — and would work, which is why nobody would notice.
 * This pins the registration: a channel whose action is a write verb must go
 * through `handleWrite`. Added at B10a with the three pilot-exit writes.
 */

const IPC = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const WRITE_VERBS = [
  'acknowledge', 'bulk-acknowledge', 'resolve', 'accept', 'record-reuse', 'save', 'retire', 'pin', 'unpin',
  'queue', 'cancel', 'reset', 'rule', 'inspect', 'promote'
];

const registrations = [...IPC.matchAll(/\b(handle|handleWrite)\(\s*'([a-z-]+):([a-z-]+)'/g)].map((m) => ({
  how: m[1] as string,
  channel: `${m[2]}:${m[3]}`,
  action: m[3] as string
}));

describe('write channels refuse in a read-only window', () => {
  it('finds the registrations it is checking', () => {
    expect(registrations.length).toBeGreaterThan(30);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining(['pilot:rule', 'pilot:inspect', 'pilot:promote'])
    );
  });

  it('registers every write-verb channel through handleWrite', () => {
    const wrong = registrations
      .filter((r) => WRITE_VERBS.includes(r.action) && r.how !== 'handleWrite')
      .map((r) => r.channel);
    expect(wrong).toEqual([]);
  });
});
