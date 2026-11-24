import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BOILER, SITE_ROUTES, TRIPLE_LIGHT, APP_TOKEN_ROUTE, fakeApi, fakeJwt, fakeLog, mockFetch, nowSec } from './helpers.js';
import { SmartGradePlatform } from '../src/platform.js';

function setup(config: Record<string, unknown>, routes = SITE_ROUTES([BOILER, TRIPLE_LIGHT, { id: 'ffeeddccbbaa', product_id: 26 }])) {
  const { api, registered, unregistered, hap } = fakeApi();
  const { log, lines } = fakeLog();
  const { fetch, calls } = mockFetch(routes);
  const platform = new SmartGradePlatform(log, { platform: 'SmartGrade', userId: 42, ...config } as any, api, fetch);
  return { platform, registered, unregistered, hap, lines, calls };
}

describe('platform', () => {
  it('does nothing (and calls nothing) without a login', async () => {
    const { platform, calls, lines } = setup({});
    await platform.start();
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => l.startsWith('warn: Not logged in')));
  });

  it('refuses an expired token without calling the cloud', async () => {
    const { platform, calls, lines } = setup({ jwt: fakeJwt(nowSec() - 5) });
    await platform.start();
    platform.stop();
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => l.includes('login expired')));
  });

  it('discovers one accessory per relay with per-device types; skips non-relay products', async () => {
    const { platform, registered, hap, calls } = setup({
      jwt: fakeJwt(nowSec() + 20 * 86400),
      devices: [{ id: BOILER.id, accessoryType: 'valve' }, { id: TRIPLE_LIGHT.id, relay: 3, hidden: true }],
    });
    await platform.poll(true);
    assert.equal(registered.length, 3, 'boiler + 2 visible light relays');
    assert.ok(registered[0].getService(hap.Service.Valve));
    assert.ok(registered[1].getService(hap.Service.Switch));
    assert.ok(calls.every((c) => c.method === 'GET'), 'polling only reads');
    assert.ok(!calls.some((c) => c.path.endsWith('last_usage_stats')), 'stats skipped when exposePower is off');
  });

  it('removes cached accessories that are no longer present', async () => {
    const { platform, unregistered, hap } = setup({ jwt: fakeJwt(nowSec() + 20 * 86400) }, SITE_ROUTES([BOILER]));
    const { FakePlatformAccessory } = await import('./helpers.js');
    platform.configureAccessory(new FakePlatformAccessory('old', hap.uuid.generate('gone')) as any);
    await platform.poll(true);
    assert.equal(unregistered.length, 1);
  });

  it('stops polling and marks accessories unreachable on 401', async () => {
    const { platform, lines } = setup({ jwt: fakeJwt(nowSec() + 20 * 86400) }, [
      APP_TOKEN_ROUTE,
      { method: 'GET', path: 'api/v1/users/42/sites', status: 401 },
    ]);
    await platform.poll(true);
    assert.equal(platform.authFailed, true);
    assert.ok(lines.some((l) => l.startsWith('error:') && l.includes('log in again')));
  });

  it('routes a HomeKit set to toggle_switches on the mocked cloud', async () => {
    const { platform, calls } = setup({ jwt: fakeJwt(nowSec() + 20 * 86400) }, [
      ...SITE_ROUTES([TRIPLE_LIGHT]),
      { method: 'POST', path: /toggle_switches$/, body: {} },
    ]);
    await platform.poll(true);
    await platform.setRelay(TRIPLE_LIGHT.id, 2, true);
    platform.stop();
    const toggle = calls.find((c) => c.method === 'POST')!;
    assert.equal(toggle.path, `api/v1/devices/${TRIPLE_LIGHT.id}/toggle_switches`);
    assert.deepEqual(toggle.body, { switch_2: true });
  });

  it('does not expose shutters even when they are listed in config', async () => {
    const shutters = [
      { id: '111111111111', name: 'Shutter 18', product_id: 18, switch_num: 2, switch_1: false, switch_2: false },
      { id: '222222222222', name: 'Shutter 19', product_id: 19, switch_num: 2, switch_1: true, switch_2: false },
      { id: '333333333333', name: 'Shutter 36', product_id: 36, switch_num: 2, switch_1: false, switch_2: true },
    ];
    const { platform, registered, hap, lines, calls } = setup({
      jwt: fakeJwt(nowSec() + 20 * 86400),
      devices: [
        { id: BOILER.id, accessoryType: 'valve' },
        { id: TRIPLE_LIGHT.id, relay: 3, hidden: true },
        { id: '111111111111', accessoryType: 'switch' },
        { id: '222222222222' },
        { id: '333333333333', relay: 1 },
      ],
    }, SITE_ROUTES([BOILER, TRIPLE_LIGHT, { id: 'ffeeddccbbaa', product_id: 26 }, ...shutters]));
    await platform.poll(true);
    platform.stop();
    assert.equal(registered.length, 3, 'boiler + 2 visible light relays; shutters and sensor omitted');
    assert.ok(registered[0].getService(hap.Service.Valve));
    const names = registered.map((a) => a.displayName).join(' ');
    assert.equal(/[Ss]hutter/.test(names), false);
    for (const name of ['Shutter 18', 'Shutter 19', 'Shutter 36']) {
      assert.ok(lines.some((l) => l.startsWith('info:') && l.includes(`Skipping shutter "${name}"`)));
      assert.ok(lines.some((l) => l.startsWith('info:') && l.includes(`Ignoring device config for shutter "${name}"`)));
    }
    assert.ok(calls.every((c) => c.method === 'GET'), 'shutter handling never writes to the cloud');
  });
});
