import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BOILER, FakePlatformAccessory, TRIPLE_LIGHT, fakeApi, fakeLog } from './helpers.js';
import { SmartGradeAccessory, type AccessoryHost } from '../src/platformAccessory.js';
import { firmwareRevision, deviceMac, relayCount, resolveRelay, suggestedAccessoryType } from '../src/products.js';
import { EVE_CHARACTERISTICS } from '../src/eve.js';

function makeHost(exposePower = false) {
  const { api, hap } = fakeApi();
  const sent: { deviceId: string; relay: number; on: boolean }[] = [];
  const host: AccessoryHost & { authFailed: boolean } = {
    api,
    log: fakeLog().log,
    exposePower,
    authFailed: false,
    async setRelay(deviceId, relay, on) {
      sent.push({ deviceId, relay, on });
    },
  };
  return { host, hap, sent };
}

function build(device: any, relay: number, configs: any[] = [], exposePower = false) {
  const { host, hap, sent } = makeHost(exposePower);
  const accessory = new FakePlatformAccessory('x', hap.uuid.generate(`t:${device.id}:${relay}`));
  const handler = new SmartGradeAccessory(host, accessory as any, device, resolveRelay(device, relay, configs));
  return { handler, accessory, hap, host, sent };
}

describe('products', () => {
  it('maps product ids, relays, MAC and firmware', () => {
    assert.equal(relayCount(BOILER), 1);
    assert.equal(relayCount(TRIPLE_LIGHT), 3);
    assert.equal(relayCount({ id: 'x', product_id: 26 }), 0, 'sensors have no relay');
    assert.equal(relayCount({ id: 'x', product_id: 99 }), 0, 'unknown product without switch_1');
    assert.equal(relayCount({ id: 'x', product_id: 99, switch_1: true }), 1);
    assert.equal(deviceMac('AABBCCDDEEFF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(deviceMac('nope'), null);
    assert.equal(firmwareRevision('20260410_var2_v2.9.2'), '2.9.2');
    assert.equal(firmwareRevision('garbage'), null);
  });

  it('suggests Valve for boilers, Outlet for sockets, Switch otherwise', () => {
    assert.equal(suggestedAccessoryType(6), 'valve');
    assert.equal(suggestedAccessoryType(8), 'valve');
    assert.equal(suggestedAccessoryType(16), 'outlet');
    assert.equal(suggestedAccessoryType(9), 'switch');
    assert.equal(suggestedAccessoryType(null), 'switch');
  });

  it('resolves per-device and per-relay overrides', () => {
    assert.equal(resolveRelay(BOILER, 1).accessoryType, 'switch', 'default without config is Switch');
    const cfg = [
      { id: 'AA:BB:CC:DD:EE:FF', accessoryType: 'valve', valveType: 'faucet', name: 'Dud' },
      { id: TRIPLE_LIGHT.id, accessoryType: 'outlet' },
      { id: TRIPLE_LIGHT.id, relay: 2, accessoryType: 'switch', name: 'Wall lamp' },
      { id: TRIPLE_LIGHT.id, relay: 3, hidden: true },
    ];
    assert.deepEqual(resolveRelay(BOILER, 1, cfg as any), {
      relay: 1, name: 'Dud', accessoryType: 'valve', valveType: 'faucet', hidden: false,
    });
    assert.equal(resolveRelay(TRIPLE_LIGHT, 1, cfg as any).accessoryType, 'outlet');
    assert.equal(resolveRelay(TRIPLE_LIGHT, 1, cfg as any).name, 'Hall lights Ceiling');
    assert.equal(resolveRelay(TRIPLE_LIGHT, 2, cfg as any).accessoryType, 'switch');
    assert.equal(resolveRelay(TRIPLE_LIGHT, 2, cfg as any).name, 'Wall lamp');
    assert.equal(resolveRelay(TRIPLE_LIGHT, 3, cfg as any).hidden, true);
    assert.equal(resolveRelay(TRIPLE_LIGHT, 3).name, 'Hall lights 3');
  });

  it('hides shutters unless configured', () => {
    const shutter = { id: '0a0b0c0d0e0f', product_id: 18, switch_num: 2, switch_1: false, switch_2: false };
    assert.equal(resolveRelay(shutter, 1).hidden, true);
    assert.equal(resolveRelay(shutter, 1, [{ id: shutter.id }]).hidden, false);
  });
});

describe('accessory type mapping', () => {
  it('Switch -> Service.Switch with On', async () => {
    const { accessory, hap, sent } = build(BOILER, 1);
    const svc = accessory.getService(hap.Service.Switch)!;
    assert.ok(svc);
    assert.equal(accessory.getService(hap.Service.Valve), undefined);
    assert.equal(svc.getCharacteristic(hap.Characteristic.On).value, false);
    await svc.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
    assert.deepEqual(sent, [{ deviceId: BOILER.id, relay: 1, on: true }]);
    assert.equal(svc.getCharacteristic(hap.Characteristic.On).value, true);
  });

  it('Outlet -> Service.Outlet with On + OutletInUse', () => {
    const { accessory, hap } = build({ ...BOILER, switch_1: true }, 1, [{ id: BOILER.id, accessoryType: 'outlet' }]);
    const svc = accessory.getService(hap.Service.Outlet)!;
    assert.ok(svc);
    assert.equal(svc.getCharacteristic(hap.Characteristic.On).value, true);
    assert.equal(svc.getCharacteristic(hap.Characteristic.OutletInUse).value, true);
  });

  it('Valve -> Service.Valve with Active/InUse/ValveType', async () => {
    const { accessory, hap, sent, handler } = build(BOILER, 1, [{ id: BOILER.id, accessoryType: 'valve' }]);
    const svc = accessory.getService(hap.Service.Valve)!;
    assert.ok(svc);
    assert.equal(svc.getCharacteristic(hap.Characteristic.ValveType).value, hap.Characteristic.ValveType.GENERIC_VALVE);
    assert.equal(svc.getCharacteristic(hap.Characteristic.Active).value, hap.Characteristic.Active.INACTIVE);
    await svc.getCharacteristic(hap.Characteristic.Active).handleSetRequest(hap.Characteristic.Active.ACTIVE);
    assert.deepEqual(sent, [{ deviceId: BOILER.id, relay: 1, on: true }]);
    assert.equal(svc.getCharacteristic(hap.Characteristic.InUse).value, hap.Characteristic.InUse.IN_USE);
    handler.update({ ...BOILER, switch_1: false }, null);
    assert.equal(svc.getCharacteristic(hap.Characteristic.Active).value, hap.Characteristic.Active.INACTIVE);
  });

  it('Valve faucet icon', () => {
    const { accessory, hap } = build(BOILER, 1, [{ id: BOILER.id, accessoryType: 'valve', valveType: 'faucet' }]);
    assert.equal(accessory.getService(hap.Service.Valve)!.getCharacteristic(hap.Characteristic.ValveType).value,
      hap.Characteristic.ValveType.WATER_FAUCET);
  });

  it('changing the type replaces the old service on the same accessory', () => {
    const { accessory, hap, handler } = build(BOILER, 1);
    handler.configure(resolveRelay(BOILER, 1, [{ id: BOILER.id, accessoryType: 'valve' }]));
    assert.equal(accessory.getService(hap.Service.Switch), undefined);
    assert.ok(accessory.getService(hap.Service.Valve));
  });

  it('sets accessory information (model, MAC serial, x.y.z firmware)', () => {
    const { accessory, hap } = build(BOILER, 1);
    const info = accessory.getService(hap.Service.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(hap.Characteristic.Model).value, 'Boiler switch (Gewiss 3-module)');
    assert.equal(info.getCharacteristic(hap.Characteristic.SerialNumber).value, 'aa:bb:cc:dd:ee:ff-1');
    assert.equal(info.getCharacteristic(hap.Characteristic.FirmwareRevision).value, '2.9.2');
  });

  it('tracks each relay of a multi-relay device separately', () => {
    const r2 = build(TRIPLE_LIGHT, 2);
    const r3 = build(TRIPLE_LIGHT, 3);
    assert.equal(r2.accessory.getService(r2.hap.Service.Switch)!.getCharacteristic(r2.hap.Characteristic.On).value, false);
    assert.equal(r3.accessory.getService(r3.hap.Service.Switch)!.getCharacteristic(r3.hap.Characteristic.On).value, true);
  });

  it('reports No Response for offline devices', async () => {
    const { accessory, hap, handler } = build(BOILER, 1);
    handler.update({ ...BOILER, is_online: false }, null);
    const on = accessory.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On);
    await assert.rejects(on.handleGetRequest(), (err: any) => (err?.hapStatus ?? err) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('adds Eve power characteristics only when enabled', () => {
    const off = build(BOILER, 1);
    const uuids: string[] = Object.values(EVE_CHARACTERISTICS).map((d) => d.uuid);
    assert.ok(!off.accessory.getService(off.hap.Service.Switch)!.characteristics.some((c) => uuids.includes(c.UUID)));
    const on = build(BOILER, 1, [], true);
    on.handler.update(BOILER, { watt: 2707, amper: 12.29, volt: 236.8 });
    const svc = on.accessory.getService(on.hap.Service.Switch)!;
    const value = (uuid: string) => svc.characteristics.find((c) => c.UUID === uuid)!.value;
    assert.equal(value(EVE_CHARACTERISTICS.power.uuid), 2707);
    assert.ok(Math.abs(Number(value(EVE_CHARACTERISTICS.current.uuid)) - 12.29) < 0.01);
    assert.equal(value(EVE_CHARACTERISTICS.voltage.uuid), 236.8);
  });
});
