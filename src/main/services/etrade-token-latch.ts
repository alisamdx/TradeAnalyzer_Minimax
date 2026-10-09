/**
 * Stop calling E*Trade once it has said the token is EXPIRED (v1.1.344).
 *
 * The collector's transport renews and retries on any failure, which is right
 * for a dormant token (it does not reliably fail as a 401). An expired one —
 * past midnight ET — cannot be renewed at all: `renew_access_token` answers 401
 * and only a manual re-auth helps. Without a stop, every remaining call of the
 * run still did call → renew → retry. Measured 2026-10-08: about 2,000 E*Trade
 * calls and 713 renews in the 17:06 run, and another ~1,800 after midnight
 * when the re-authed token expired inside the 23:52 run, every one a 401.
 *
 * The latch is tripped only by the RETRY's answer, after the renew has been
 * attempted, and only by `oauth_problem=token_expired`. A dormant token says
 * `token_rejected`, which a renew can fix, so it never trips the latch. The
 * renew decision itself is still made on "not 2xx" alone.
 *
 * Keyed on the access token, so a re-auth in the middle of a run clears it.
 */
export function isExpiredTokenResponse(r: { status: number | null; body: string }): boolean {
  return r.status === 401 && /oauth_problem=token_expired/i.test(r.body);
}

export const EXPIRED_TOKEN_SKIP_MESSAGE =
  'E*Trade token expired — call not sent; re-authenticate in Settings (expired tokens cannot be renewed).';

export class ExpiredTokenLatch {
  private expiredToken: string | null = null;

  trip(accessToken: string): void {
    this.expiredToken = accessToken;
  }

  /** True while the token in use is the one E*Trade declared expired. */
  isTripped(currentAccessToken: string): boolean {
    return this.expiredToken !== null && this.expiredToken === currentAccessToken;
  }
}
