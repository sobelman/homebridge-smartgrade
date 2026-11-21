import type { API, Logging, PlatformAccessory, Service } from 'homebridge';

import type { SmartGradeDevice, SmartGradeUsageStats } from './api/types.js';
import { ensureEveCharacteristic, removeEveCharacteristics } from './eve.js';
import { deviceMac, firmwareRevision, productId, productName, type ResolvedRelay } from './products.js';
import { MANUFACTURER, type AccessoryType } from './settings.js';

/** What the accessory needs from the platform (kept small so tests can fake it). */
export interface AccessoryHost {
  readonly api: API;
  readonly log: Logging;
  readonly exposePower: boolean;
  /** Send the relay command to the cloud and schedule a state refresh. */
  setRelay(deviceId: string, relay: number, on: boolean): Promise<void>;
  /** True while the stored JWT is missing/expired (accessories report "No Response"). */
  readonly authFailed: boolean;
}

export interface AccessoryContext {
  deviceId: string;
  relay: number;
  accessoryType?: AccessoryType;
}

/** Number from the cloud (it sometimes sends strings), or null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One HomeKit accessory for one relay of a SmartGrade device, exposed as a
 * Switch, Outlet or Valve service depending on the per-device config.
 */
export class SmartGradeAccessory {
  private service!: Service;
  private on = false;
  private online = true;
  private stats: SmartGradeUsageStats | null = null;

  constructor(
    private readonly host: AccessoryHost,
    public readonly accessory: PlatformAccessory<AccessoryContext> | PlatformAccessory,
    private device: SmartGradeDevice,
    private resolved: ResolvedRelay,
  ) {
    this.configure();
    this.update(device, null);
  }

  get deviceId(): string {
    return this.device.id;
  }

  get relay(): number {
    return this.resolved.relay;
  }

  get accessoryType(): AccessoryType {
    return this.resolved.accessoryType;
  }

  /** The service carrying On/Active (exposed for tests). */
  get primaryService(): Service {
    return this.service;
  }

  private get hap() {
    return this.host.api.hap;
  }

  /** (Re)build services. Safe on cached accessories and on accessory-type changes. */
  configure(resolved: ResolvedRelay = this.resolved): void {
    this.resolved = resolved;
    const { Service, Characteristic } = this.hap;
    const ctx = this.accessory.context as AccessoryContext;
    ctx.deviceId = this.device.id;
    ctx.relay = resolved.relay;
    ctx.accessoryType = resolved.accessoryType;

    const pid = productId(this.device);
    const info = this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, productName(pid))
      .setCharacteristic(Characteristic.SerialNumber, `${deviceMac(this.device.id) ?? this.device.id}-${resolved.relay}`);
    const fw = firmwareRevision(this.device.firmware);
    if (fw) {
      info.setCharacteristic(Characteristic.FirmwareRevision, fw);
    }

    const wanted = {
      switch: Service.Switch,
      outlet: Service.Outlet,
      valve: Service.Valve,
    }[resolved.accessoryType];

    // Drop services of a previously configured type.
    for (const old of [Service.Switch, Service.Outlet, Service.Valve]) {
      if (old.UUID !== wanted.UUID) {
        const existing = this.accessory.getService(old);
        if (existing) {
          this.accessory.removeService(existing);
        }
      }
    }

    this.service = this.accessory.getService(wanted) ?? this.accessory.addService(wanted, resolved.name);
    this.service.setCharacteristic(Characteristic.Name, resolved.name);

    if (resolved.accessoryType === 'valve') {
      this.service.setCharacteristic(
        Characteristic.ValveType,
        resolved.valveType === 'faucet' ? Characteristic.ValveType.WATER_FAUCET : Characteristic.ValveType.GENERIC_VALVE,
      );
      this.service.getCharacteristic(Characteristic.Active)
        .onGet(() => this.readOn() ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
        .onSet((value) => this.writeOn(value === Characteristic.Active.ACTIVE || value === 1 || value === true));
      this.service.getCharacteristic(Characteristic.InUse)
        .onGet(() => this.readOn() ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
    } else {
      this.service.getCharacteristic(Characteristic.On)
        .onGet(() => this.readOn())
        .onSet((value) => this.writeOn(Boolean(value)));
      if (resolved.accessoryType === 'outlet') {
        this.service.getCharacteristic(Characteristic.OutletInUse).onGet(() => this.outletInUse());
      }
    }

    if (this.host.exposePower) {
      ensureEveCharacteristic(this.host.api, this.service, 'power');
      ensureEveCharacteristic(this.host.api, this.service, 'current');
      ensureEveCharacteristic(this.host.api, this.service, 'voltage');
    } else {
      removeEveCharacteristics(this.service);
    }
    this.accessory.displayName = resolved.name;
  }

  private assertReachable(): void {
    if (this.host.authFailed || !this.online) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private readOn(): boolean {
    this.assertReachable();
    return this.on;
  }

  private outletInUse(): boolean {
    this.assertReachable();
    const watt = toNumber(this.stats?.watt);
    return watt === null ? this.on : this.on && watt > 1;
  }

  private async writeOn(on: boolean): Promise<void> {
    this.assertReachable();
    try {
      await this.host.setRelay(this.device.id, this.resolved.relay, on);
    } catch (err) {
      this.host.log.error(`[${this.resolved.name}] Could not turn ${on ? 'on' : 'off'}: ${(err as Error)?.message ?? err}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    // Optimistic; the next poll reads the real state (toggle echo can be stale).
    this.setOn(on);
  }

  private setOn(on: boolean): void {
    this.on = on;
    const { Characteristic } = this.hap;
    if (this.resolved.accessoryType === 'valve') {
      this.service.updateCharacteristic(Characteristic.Active, on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      this.service.updateCharacteristic(Characteristic.InUse, on ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
    } else {
      this.service.updateCharacteristic(Characteristic.On, on);
      if (this.resolved.accessoryType === 'outlet') {
        const watt = toNumber(this.stats?.watt);
        this.service.updateCharacteristic(Characteristic.OutletInUse, watt === null ? on : on && watt > 1);
      }
    }
  }

  /** Push a fresh device object (and optional power reading) into HomeKit. */
  update(device: SmartGradeDevice, stats: SmartGradeUsageStats | null): void {
    this.device = device;
    if (stats) {
      this.stats = stats;
    }
    this.online = device.is_online !== false;
    const raw = device[`switch_${this.resolved.relay}`];
    if (typeof raw === 'boolean') {
      this.setOn(raw);
    }
    if (this.host.exposePower && this.stats) {
      const values = {
        power: toNumber(this.stats.watt),
        current: toNumber(this.stats.amper),
        voltage: toNumber(this.stats.volt),
      };
      for (const [key, value] of Object.entries(values)) {
        if (value !== null) {
          ensureEveCharacteristic(this.host.api, this.service, key as 'power').updateValue(Math.max(0, value));
        }
      }
    }
  }
}
