import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeJwt, nowSec } from './helpers.js';
import { jwtExp, tokenStatus } from '../src/api/jwt.js';

describe('JWT expiry detection', () => {
  it('reads exp without verifying the signature', () => {
    assert.equal(jwtExp(fakeJwt(1_900_000_000)), 1_900_000_000);
    assert.equal(jwtExp('not-a-jwt'), 0);
    assert.equal(jwtExp(null), 0);
  });

  it('classifies missing / valid / expiring / expired', () => {
    const now = nowSec();
    assert.equal(tokenStatus(undefined).state, 'missing');
    assert.equal(tokenStatus(fakeJwt(now + 20 * 86400), now).state, 'valid');
    assert.equal(tokenStatus(fakeJwt(now + 20 * 86400), now).daysLeft, 20);
    const expiring = tokenStatus(fakeJwt(now + 2 * 86400 + 10), now);
    assert.equal(expiring.state, 'expiring');
    assert.equal(expiring.daysLeft, 2);
    assert.equal(tokenStatus(fakeJwt(now - 10), now).state, 'expired');
    assert.equal(tokenStatus('opaque-token', now).state, 'valid', 'unknown expiry is left to the cloud');
  });
});
