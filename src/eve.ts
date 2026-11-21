import type { API, Characteristic, Service } from 'homebridge';

/** Eve custom characteristics (read-only), as used by Eve Energy and many plugins. */
export const EVE_CHARACTERISTICS = {
  power: { uuid: 'E863F10D-079E-48FF-8F27-9C2605A29F52', name: 'Consumption', unit: 'W', maxValue: 100000 },
  current: { uuid: 'E863F126-079E-48FF-8F27-9C2605A29F52', name: 'Electric Current', unit: 'A', maxValue: 1000 },
  voltage: { uuid: 'E863F10A-079E-48FF-8F27-9C2605A29F52', name: 'Voltage', unit: 'V', maxValue: 1000 },
} as const;

export type EveKey = keyof typeof EVE_CHARACTERISTICS;

/** Find or add an Eve characteristic on a service. */
export function ensureEveCharacteristic(api: API, service: Service, key: EveKey): Characteristic {
  const def = EVE_CHARACTERISTICS[key];
  const existing = service.characteristics.find((c) => c.UUID === def.uuid);
  if (existing) {
    return existing;
  }
  const hap = api.hap;
  const characteristic = new hap.Characteristic(def.name, def.uuid, {
    format: hap.Formats.FLOAT,
    perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
    unit: def.unit,
    minValue: 0,
    maxValue: def.maxValue,
    minStep: 0.01,
  });
  return service.addCharacteristic(characteristic);
}

/** Remove all Eve power characteristics from a service (when the option is off). */
export function removeEveCharacteristics(service: Service): void {
  const uuids = new Set<string>(Object.values(EVE_CHARACTERISTICS).map((d) => d.uuid));
  for (const c of [...service.characteristics]) {
    if (uuids.has(c.UUID)) {
      service.removeCharacteristic(c);
    }
  }
}
