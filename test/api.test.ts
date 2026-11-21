import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_TOKEN_ROUTE, BOILER, SITE_ROUTES, TRIPLE_LIGHT, fakeJwt, mockFetch, nowSec } from './helpers.js';
import {
  APP_PASSWORD,
  APP_USER,
  SmartGradeApi,
  SmartGradeAuthError,
  SmartGradeConnectionError,
  isValidMobile,
  normalizeMobile,
} from '../src/api/index.js';

describe('app token', () => {
  it('fetches with HTTP Basic app credentials and caches it', async () => {
    const { fetch, calls } = mockFetch([APP_TOKEN_ROUTE]);
    const api = new SmartGradeApi({ fetch });
    assert.equal(await api.getAppToken(), 'test-app-token');
    assert.equal(await api.getAppToken(), 'test-app-token');
    assert.equal(calls.length, 1, 'second call served from cache');
    const expected = 'Basic ' + Buffer.from(`${APP_USER}:${APP_PASSWORD}`).toString('base64');
    assert.equal(calls[0].headers.Authorization, expected);
    assert.equal(calls[0].url, 'https://api.iotechv.com/api/v1/apps/token');
  });

  it('refetches when within an hour of expiry', async () => {
    const { fetch, calls } = mockFetch([{ ...APP_TOKEN_ROUTE, body: { token: 't', exp: nowSec() + 60 } }]);
    const api = new SmartGradeApi({ fetch });
    await api.getAppToken();
    await api.getAppToken();
    assert.equal(calls.length, 2);
  });

  it('rejects malformed token responses', async () => {
    const { fetch } = mockFetch([{ ...APP_TOKEN_ROUTE, body: { nope: 1 } }]);
    await assert.rejects(new SmartGradeApi({ fetch }).getAppToken(), SmartGradeConnectionError);
  });

  it('wraps network failures', async () => {
    const api = new SmartGradeApi({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(api.getAppToken(), SmartGradeConnectionError);
  });
});

describe('SMS login', () => {
  it('normalises and validates mobile numbers', () => {
    assert.equal(normalizeMobile('+972 50-000-0000'), '0500000000');
    assert.equal(normalizeMobile('050-0000000'), '0500000000');
    assert.ok(isValidMobile('0500000000'));
    assert.ok(!isValidMobile('12345'));
  });

  it('requests an SMS with the verified body and the app token header', async () => {
    const { fetch, calls } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: 'api/v1/customers', body: { success: true } }]);
    const api = new SmartGradeApi({ fetch });
    assert.equal(await api.requestSms('+972500000000'), true);
    const sms = calls.find((c) => c.path === 'api/v1/customers')!;
    assert.deepEqual(sms.body, { customer: { mobile: '0500000000' } });
    assert.equal(sms.headers['X-APP-TOKEN'], 'Bearer test-app-token');
    assert.equal(sms.headers.Authorization, undefined, 'no user JWT before login');
  });

  it('returns false when the number is rejected (4xx)', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: 'api/v1/customers', status: 422, body: {} }]);
    assert.equal(await new SmartGradeApi({ fetch }).requestSms('0500000000'), false);
  });

  it('exchanges the code for a JWT and user id', async () => {
    const jwt = fakeJwt(nowSec() + 30 * 86400);
    const { fetch, calls } = mockFetch([
      APP_TOKEN_ROUTE,
      { method: 'POST', path: 'api/v1/users/login/code', body: { jwt, user: { id: 42, mobile: 'x' } } },
    ]);
    const api = new SmartGradeApi({ fetch });
    const res = await api.submitCode(' 1234 ');
    assert.deepEqual(res, { jwt, userId: 42 });
    assert.equal(api.jwt, jwt);
    assert.deepEqual(calls.at(-1)!.body, { user: { code: '1234' } });
    assert.ok(Math.abs(api.jwtExpiresAt - (nowSec() + 30 * 86400)) < 5);
  });

  it('treats a wrong code (4xx) as an auth error', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: 'api/v1/users/login/code', status: 400, body: {} }]);
    await assert.rejects(new SmartGradeApi({ fetch }).submitCode('0000'), SmartGradeAuthError);
  });

  it('treats a response without jwt as an auth error', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: 'api/v1/users/login/code', body: { user: {} } }]);
    await assert.rejects(new SmartGradeApi({ fetch }).submitCode('1234'), SmartGradeAuthError);
  });
});

describe('data', () => {
  const jwt = fakeJwt(nowSec() + 86400 * 20);

  it('sends both the JWT and the app token, and parses the bare device array', async () => {
    const { fetch, calls } = mockFetch(SITE_ROUTES([BOILER, TRIPLE_LIGHT]));
    const api = new SmartGradeApi({ fetch, jwt, userId: 42 });
    const devices = await api.getAllDevices();
    assert.deepEqual([...devices.keys()], [BOILER.id, TRIPLE_LIGHT.id]);
    assert.equal(devices.get(BOILER.id)!.site_name, 'Home');
    assert.equal(devices.get(BOILER.id)!.site_id, 7);
    const sites = calls.find((c) => c.path === 'api/v1/users/42/sites')!;
    assert.ok(sites.url.endsWith('?shared=true'));
    assert.equal(sites.headers.Authorization, `Bearer ${jwt}`);
    assert.equal(sites.headers['X-APP-TOKEN'], 'Bearer test-app-token');
  });

  it('also accepts the older {devices: [...]} / {sites: [...]} shapes', async () => {
    const { fetch } = mockFetch([
      APP_TOKEN_ROUTE,
      { method: 'GET', path: 'api/v1/users/42/sites', body: { sites: [{ id: 7 }] } },
      { method: 'GET', path: 'api/v1/sites/7/devices', body: { devices: [BOILER, { name: 'no id' }] } },
    ]);
    const devices = await new SmartGradeApi({ fetch, jwt, userId: 42 }).getAllDevices();
    assert.deepEqual([...devices.keys()], [BOILER.id]);
  });

  it('fetches the user id from the profile when unknown', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'GET', path: 'api/v1/users/profile', body: { user: { id: 42 } } }]);
    assert.equal(await new SmartGradeApi({ fetch, jwt }).getUserId(), 42);
  });

  it('raises an auth error on 401 and without a JWT', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'GET', path: 'api/v1/users/42/sites', status: 401 }]);
    await assert.rejects(new SmartGradeApi({ fetch, jwt, userId: 42 }).getSites(), SmartGradeAuthError);
    await assert.rejects(new SmartGradeApi({ fetch, userId: 42 }).getSites(), SmartGradeAuthError);
  });

  it('parses last_usage_stats', async () => {
    const stats = {
      volt: 236.8, amper: 12.29, watt: 2707, watt2: 0, watt3: 0, powerFactor: 1, signalStrength: -61, createdAt: '2026-11-20T10:00:00Z',
    };
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'GET', path: `api/v1/devices/${BOILER.id}/last_usage_stats`, body: stats }]);
    assert.deepEqual(await new SmartGradeApi({ fetch, jwt }).getLastUsageStats(BOILER.id), stats);
  });

  it('parses timers, next_action and future_actions (read-only)', async () => {
    const timer = {
      id: 1, name: 'Morning', is_enabled: true, timer_kind: 'recurring',
      timer_detail: { days: [0, 1, 2, 3, 4], on_time: '06:00', off_time: '06:50', switch_1: true },
    };
    const { fetch, calls } = mockFetch([
      APP_TOKEN_ROUTE,
      { method: 'GET', path: /timers$/, body: { timers: [timer, 'junk'] } },
      { method: 'GET', path: /next_action$/, body: { next_action: { ts: 2_000_000_000, switch_1: true, created_by: 'timer' } } },
      { method: 'GET', path: /future_actions$/, body: [{ ts: 2_000_000_000, switch_1: true }, { switch_1: false }] },
    ]);
    const api = new SmartGradeApi({ fetch, jwt });
    assert.deepEqual(await api.getTimers(BOILER.id), [timer]);
    assert.equal((await api.getNextAction(BOILER.id))!.ts, 2_000_000_000);
    assert.equal((await api.getFutureActions(BOILER.id)).length, 1);
    assert.ok(calls.every((c) => c.method === 'GET'), 'timer reads never write');
  });

  it('returns null / [] when nothing is scheduled (404 or empty)', async () => {
    const { fetch } = mockFetch([APP_TOKEN_ROUTE, { method: 'GET', path: /next_action$/, body: {} }]);
    const api = new SmartGradeApi({ fetch, jwt });
    assert.equal(await api.getNextAction(BOILER.id), null);
    assert.deepEqual(await api.getFutureActions(BOILER.id), []);
  });

  it('builds the toggle_switches payload for each relay (mocked, never sent anywhere)', async () => {
    const { fetch, calls } = mockFetch([APP_TOKEN_ROUTE, { method: 'POST', path: /toggle_switches$/, body: { switch_1: false } }]);
    const api = new SmartGradeApi({ fetch, jwt });
    await api.setSwitch('aabbccddeeff', true);
    await api.setSwitch('aabbccddeeff', false, 3);
    const toggles = calls.filter((c) => c.path.endsWith('toggle_switches'));
    assert.equal(toggles[0].path, 'api/v1/devices/aabbccddeeff/toggle_switches');
    assert.deepEqual(toggles.map((c) => c.body), [{ switch_1: true }, { switch_3: false }]);
    await assert.rejects(api.setSwitch('aabbccddeeff', true, 4), RangeError);
  });
});
