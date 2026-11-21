import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_TOKEN_ROUTE, BOILER, SITE_ROUTES, fakeJwt, mockFetch, nowSec } from './helpers.js';
import { UiError, createUiHandlers } from '../homebridge-ui/handlers.js';
import { upcomingActions } from '../src/deviceInfo.js';

describe('custom UI handlers', () => {
  it('validates the mobile number before calling the cloud', async () => {
    const { fetch, calls } = mockFetch([APP_TOKEN_ROUTE]);
    await assert.rejects(createUiHandlers(fetch).sendSms({ mobile: '123' }), UiError);
    assert.equal(calls.length, 0);
  });

  it('runs the phone -> SMS -> code flow and returns the JWT to save', async () => {
    const jwt = fakeJwt(nowSec() + 30 * 86400);
    const { fetch, calls } = mockFetch([
      APP_TOKEN_ROUTE,
      { method: 'POST', path: 'api/v1/customers', body: { success: true } },
      { method: 'POST', path: 'api/v1/users/login/code', body: { jwt, user: { id: 42 } } },
    ]);
    const ui = createUiHandlers(fetch);
    assert.deepEqual(await ui.sendSms({ mobile: '+972-50-000-0000' }), { sent: true, mobile: '0500000000' });
    const res = await ui.submitCode({ code: '1234' });
    assert.equal(res.jwt, jwt);
    assert.equal(res.userId, 42);
    assert.equal(res.status.state, 'valid');
    assert.equal(calls.filter((c) => c.path === 'api/v1/apps/token').length, 1, 'one app token for the whole login');
  });

  it('shows a friendly error for a wrong code', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: 'api/v1/users/login/code', status: 401 }]);
    await assert.rejects(createUiHandlers(fetch).submitCode({ code: '9999' }), /rejected or has expired/);
  });

  it('reports token status without any network call', () => {
    assert.equal(createUiHandlers(mockFetch([]).fetch).status({ jwt: fakeJwt(nowSec() + 86400) }).state, 'expiring');
  });

  it('lists devices with read-only details, timers and the next action', async () => {
    const future = nowSec() + 3600;
    const { fetch, calls } = mockFetch([
      ...SITE_ROUTES([{
        ...BOILER,
        site_id: 7,
        timers: [{
          name: 'Morning', is_enabled: true, timer_kind: 'recurring',
          timer_detail: { days: [0, 1], on_time: '06:00', off_time: '06:50', switch_1: true },
        }],
      }]),
      { method: 'GET', path: /last_usage_stats$/, body: { watt: 0, amper: 0, volt: 241, signalStrength: -60 } },
      { method: 'GET', path: /next_action$/, body: { ts: future, switch_1: true } },
      { method: 'GET', path: /future_actions$/, body: [{ ts: future, switch_1: true }] },
    ]);
    const { devices } = await createUiHandlers(fetch).devices({ jwt: fakeJwt(nowSec() + 20 * 86400), userId: 42 });
    assert.equal(devices.length, 1);
    const d = devices[0];
    assert.equal(d.mac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(d.suggestedType, 'valve');
    assert.equal(d.modelHebrew, 'מתג חכם לדוד לגוויס 3 מקומות');
    assert.equal(d.power!.volt, 241);
    assert.equal(d.timers[0].on_time, '06:00');
    assert.deepEqual(d.timers[0].switches, [1]);
    assert.equal(d.upcoming.length, 1, 'duplicate next/future action merged');
    assert.equal(d.upcoming[0].action, 'on');
    assert.ok(calls.every((c) => c.method === 'GET'), 'device listing never writes');
  });

  it('drops past actions and handles millisecond timestamps', () => {
    const now = Date.now();
    const res = upcomingActions({ ts: now + 120_000, switch_1: false }, [{ ts: Math.floor(now / 1000) - 3600, switch_1: true }], now);
    assert.equal(res.length, 1);
    assert.equal(res[0].action, 'off');
  });
});
