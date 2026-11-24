import type { SmartGradeDevice } from './api/types.js';
import type { AccessoryType, DeviceConfig, ValveKind } from './settings.js';

/**
 * product_id -> [English name, Hebrew name], taken from the official app's
 * strings (same table as the Home Assistant integration).
 */
export const PRODUCTS: Readonly<Record<number, readonly [string, string]>> = {
  2: ['Smart adapter for Israeli socket', 'מתאם חכם לשקע ישראלי'],
  5: ['Smart switch for 16A socket', 'מתג חכם לשקע בריטי 16A'],
  6: ['Boiler switch (under plaster)', 'מתג חכם לדוד להתקנה תת-טיח'],
  7: ['Wi-Fi switch (box 55)', 'מתג חכם WIFI לקופסא 55'],
  8: ['Boiler switch (Gewiss 3-module)', 'מתג חכם לדוד לגוויס 3 מקומות'],
  9: ['Light switch, 3 gangs (Gewiss)', 'מתג חכם לתאורה 3 לגוויס'],
  10: ['Light switch, 2 gangs (Gewiss)', 'מתג חכם לתאורה 2 לגוויס'],
  11: ['Light switch, 1 gang (Gewiss)', 'מתג חכם לתאורה 1 לגוויס'],
  12: ['Light switch, 1 gang (box 55)', 'מתג חכם לתאורה 1 לקופסא 55'],
  13: ['Light switch, 2 gangs (box 55)', 'מתג חכם לתאורה 2 לקופסא 55'],
  14: ['DIN rail switch, 1-phase 16A', 'מתג חכם פס דין, חד פאזי 16A'],
  15: ['DIN rail switch, 3-phase 30A', 'מתג חכם פס דין, תלת פאזי 30A'],
  16: ['Smart socket (box 55)', 'שקע חכם לקופסא 55'],
  17: ['Smart socket (Gewiss 3-module)', 'שקע חכם לגוויס 3 מקומות'],
  18: ['Smart shutter', 'תריס חכם'],
  19: ['Smart shutter', 'תריס חכם'],
  20: ['Smart AC panel', 'פאנל מזגן חכם'],
  21: ['Smart gateway (Zigbee)', 'גייטווי חכם (Zigbee)'],
  22: ['DIN rail switch, 1-phase 63A', 'מתג חכם, פס דין 63A'],
  23: ['Smart power meter', 'מונה חשמל חכם'],
  24: ['Smart AC panel', 'פאנל מזגן חכם'],
  25: ['Smart IR controller', 'אינפרא אדום חכם'],
  26: ['Smart motion sensor', 'חיישן תנועה חכם'],
  27: ['Smart water leak sensor', 'חיישן הצפה חכם'],
  28: ['Smart smoke sensor', 'חיישן עשן חכם'],
  29: ['Smart gas sensor', 'חיישן גז חכם'],
  30: ['Smart AC panel I', 'פאנל מזגן I חכם'],
  31: ['Smart temperature/humidity sensor', 'חיישן טמפרטורה/לחות חכם'],
  35: ['Smart IR controller', 'אינפרא אדום חכם'],
  36: ['Smart shutter', 'תריס חכם'],
};

/** Plain on/off relays. */
export const SWITCH_PRODUCTS = new Set([2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 22]);
/** Boiler (water heater) switches: Valve is the suggested HomeKit type. */
export const BOILER_PRODUCTS = new Set([6, 8]);
/** Sockets / plug adapters: Outlet is the suggested HomeKit type. */
export const OUTLET_PRODUCTS = new Set([2, 5, 16, 17]);
/** Shutter products. Control is not supported yet (no HomeKit accessory). */
export const SHUTTER_PRODUCTS = new Set([18, 19, 36]);

export function isShutterProduct(pid: number | null): boolean {
  return pid !== null && SHUTTER_PRODUCTS.has(pid);
}

/** Canonical device id for config / lookups (lowercase, no colons or dashes). */
export function normalizeDeviceId(id: unknown): string {
  return String(id ?? '').replace(/[:-]/g, '').toLowerCase();
}
/** Products without user-facing relays (AC, IR, gateway, meter, sensors). */
export const NON_RELAY_PRODUCTS = new Set([20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 35]);

export function productId(device: SmartGradeDevice): number | null {
  const n = Number(device.product_id);
  return device.product_id === null || device.product_id === undefined || !Number.isInteger(n) ? null : n;
}

export function productName(id: number | null): string {
  return id !== null && PRODUCTS[id] ? PRODUCTS[id][0] : `SmartGrade device (product ${id})`;
}

/** MAC address encoded in a device id (12 hex digits), or null. */
export function deviceMac(deviceId: string): string | null {
  const raw = String(deviceId).replace(/[:-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(raw)) {
    return null;
  }
  return raw.match(/../g)!.join(':');
}

/** HomeKit FirmwareRevision must look like x.y.z: pull "2.9.2" out of "20260410_var2_v2.9.2". */
export function firmwareRevision(firmware: string | null | undefined): string | null {
  const m = /v?(\d+\.\d+(?:\.\d+)?)\s*$/.exec(String(firmware ?? ''));
  return m ? m[1] : null;
}

/**
 * How many relays (switch_1..switch_3) a device exposes as HomeKit accessories.
 * Shutter products and products without relays return 0.
 */
export function relayCount(device: SmartGradeDevice): number {
  const pid = productId(device);
  if (pid !== null && (NON_RELAY_PRODUCTS.has(pid) || SHUTTER_PRODUCTS.has(pid))) {
    return 0;
  }
  if (
    (pid === null || !SWITCH_PRODUCTS.has(pid)) &&
    typeof device.switch_1 !== 'boolean'
  ) {
    return 0;
  }
  const n = Math.trunc(Number(device.switch_num ?? 1));
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 1;
}

/** The accessory type the settings UI pre-selects for a product. */
export function suggestedAccessoryType(pid: number | null): AccessoryType {
  if (pid !== null && BOILER_PRODUCTS.has(pid)) {
    return 'valve';
  }
  if (pid !== null && OUTLET_PRODUCTS.has(pid)) {
    return 'outlet';
  }
  return 'switch';
}

export interface ResolvedRelay {
  relay: number;
  name: string;
  accessoryType: AccessoryType;
  valveType: ValveKind;
  hidden: boolean;
}

/**
 * Resolve how one relay of a device is exposed. A config entry for the exact
 * relay wins over an entry for the whole device; without any entry the relay
 * is a Switch.
 */
export function resolveRelay(device: SmartGradeDevice, relay: number, configs: DeviceConfig[] = []): ResolvedRelay {
  const id = normalizeDeviceId(device.id);
  const forDevice = configs.filter((c) => c && normalizeDeviceId(c.id) === id);
  const exact = forDevice.find((c) => Number(c.relay) === relay);
  const whole = forDevice.find((c) => c.relay === undefined || c.relay === null || String(c.relay) === '');
  const merged: DeviceConfig = { id, ...whole, ...exact };

  const count = relayCount(device);
  const relayName = (device[`switch_${relay}_name`] as string | null | undefined)?.trim();
  const baseName = (device.name ?? '').trim() || `SmartGrade ${id.slice(-4)}`;
  let name = merged.name?.trim() || baseName;
  if (count > 1 && !(exact?.name?.trim())) {
    name = `${name} ${relayName || relay}`;
  }

  const type = merged.accessoryType && ['switch', 'outlet', 'valve'].includes(merged.accessoryType)
    ? merged.accessoryType
    : 'switch';
  return {
    relay,
    name,
    accessoryType: type,
    valveType: merged.valveType === 'faucet' ? 'faucet' : 'generic',
    hidden: Boolean(merged.hidden),
  };
}
