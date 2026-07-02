// Regression: renewAccessToken must hit E*Trade's REAL OAuth renew endpoint
// (/oauth/renew_access_token), NOT /v1/oauth/renew_access_token.
//
// The wrong '/v1/oauth/...' path made every dormant-token renewal fail (bad URL),
// so tokens idle > 2 h were never revived and always surfaced as "token expired"
// until a manual re-auth. Found live 2026-07-02: a token reconnected at ~11 am
// (brief succeeded) returned oauth_problem=token_rejected on the 5 pm batch and in
// an on-demand options fetch, because the afternoon was all Polygon traffic → the
// E*Trade token went dormant → renew hit the wrong URL → never recovered.
//
// The other E*Trade dormancy tests MOCK renewAccessToken, so they can't catch a bad
// URL — this test calls the real function against a stubbed global fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renewAccessToken, type OAuthCredentials } from '../src/main/services/etrade-auth.js';

const creds: OAuthCredentials = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };

describe('renewAccessToken — endpoint URL', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls the E*Trade OAuth renew endpoint under /oauth/, not /v1/oauth/', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await renewAccessToken(creds);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.etrade.com/oauth/renew_access_token');
    expect(url).not.toContain('/v1/oauth/');
  });

  it('throws when E*Trade rejects the renew, so callers can react', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => '<Error><message>oauth_problem=token_rejected</message></Error>',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(renewAccessToken(creds)).rejects.toThrow();
  });
});
