/** Seconds the 30-day user JWT lasts (verified live: iat -> exp = 2,592,000 s). */
export const JWT_LIFETIME_SECONDS = 30 * 24 * 3600;

/** Warn this many seconds before the JWT expires. */
export const JWT_WARN_SECONDS = 5 * 24 * 3600;

/**
 * Return the `exp` claim of a JWT (seconds since epoch), or 0 if unknown.
 * The signature is not verified; this is only used to detect expiry early.
 */
export function jwtExp(token: string | null | undefined): number {
  if (!token) {
    return 0;
  }
  try {
    const payload = token.split('.')[1];
    if (!payload) {
      return 0;
    }
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = Number(json?.exp);
    return Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0;
  } catch {
    return 0;
  }
}

export type TokenState = 'missing' | 'valid' | 'expiring' | 'expired';

export interface TokenStatus {
  state: TokenState;
  /** Expiry as epoch seconds (0 if unknown). */
  expiresAt: number;
  /** Whole days left (negative when expired, null when unknown). */
  daysLeft: number | null;
}

/** Classify a JWT: missing / valid / expiring (< 5 days) / expired. */
export function tokenStatus(token: string | null | undefined, nowSeconds = Date.now() / 1000): TokenStatus {
  if (!token) {
    return { state: 'missing', expiresAt: 0, daysLeft: null };
  }
  const exp = jwtExp(token);
  if (!exp) {
    // Unknown expiry: treat as valid; the cloud answers 401 when it is not.
    return { state: 'valid', expiresAt: 0, daysLeft: null };
  }
  const left = exp - nowSeconds;
  const daysLeft = Math.floor(left / 86400);
  if (left <= 0) {
    return { state: 'expired', expiresAt: exp, daysLeft };
  }
  if (left < JWT_WARN_SECONDS) {
    return { state: 'expiring', expiresAt: exp, daysLeft };
  }
  return { state: 'valid', expiresAt: exp, daysLeft };
}
