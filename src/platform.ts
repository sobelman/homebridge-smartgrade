import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { SmartGradeApi } from './api/client.js';
import { SmartGradeAuthError } from './api/errors.js';
import { tokenStatus } from './api/jwt.js';
import type { FetchLike, SmartGradeDevice, SmartGradeUsageStats } from './api/types.js';
import { type AccessoryContext, type AccessoryHost, SmartGradeAccessory } from './platformAccessory.js';
import { isShutterProduct, normalizeDeviceId, productId, productName, relayCount, resolveRelay } from './products.js';
import {
  DEFAULT_POLL_INTERVAL,
  MIN_POLL_INTERVAL,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type SmartGradePlatformConfig,
} from './settings.js';

const RELOGIN_HINT = 'Open Homebridge UI → Plugins → SmartGrade → Settings, log in again with the SMS code, then restart Homebridge.';

/**
 * Dynamic platform: discovers every device of the account (all sites) and
 * exposes one HomeKit accessory per relay, polling the cloud for state.
 */
export class SmartGradePlatform implements DynamicPlatformPlugin, AccessoryHost {
  public readonly config: SmartGradePlatformConfig;
  public readonly client: SmartGradeApi;
  public readonly exposePower: boolean;
  public authFailed = false;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, SmartGradeAccessory>();
  private readonly pollMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastErrorLogged = '';

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
    fetchImpl?: FetchLike,
  ) {
    this.config = config as SmartGradePlatformConfig;
    this.exposePower = Boolean(this.config.exposePower);
    const interval = Number(this.config.pollInterval ?? DEFAULT_POLL_INTERVAL);
    this.pollMs = Math.max(MIN_POLL_INTERVAL, Number.isFinite(interval) ? interval : DEFAULT_POLL_INTERVAL) * 1000;
    this.client = new SmartGradeApi({ jwt: this.config.jwt, userId: this.config.userId, fetch: fetchImpl });

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });
    this.api.on('shutdown', () => this.stop());
  }

  /** Called by Homebridge for every cached accessory at startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  /** True when the stored JWT is usable; logs a clear message otherwise. */
  checkToken(): boolean {
    const status = tokenStatus(this.config.jwt);
    switch (status.state) {
      case 'missing':
        this.log.warn('Not logged in yet. ' + RELOGIN_HINT.replace('again ', ''));
        return false;
      case 'expired':
        this.authFailed = true;
        this.log.error('⚠️ The SmartGrade login expired (the vendor JWT lasts 30 days and cannot be refreshed). ' + RELOGIN_HINT);
        return false;
      case 'expiring':
        this.log.warn(`⚠️ The SmartGrade login expires in ${Math.max(0, status.daysLeft ?? 0)} day(s). ${RELOGIN_HINT}`);
        return true;
      default:
        return true;
    }
  }

  async start(): Promise<void> {
    if (!this.checkToken()) {
      return;
    }
    // Re-check the expiry once a day so the warning shows up in the log.
    this.expiryTimer = setInterval(() => this.checkToken(), 24 * 3600 * 1000);
    this.expiryTimer.unref?.();
    await this.poll(true);
    this.pollTimer = setInterval(() => void this.poll(false), this.pollMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    for (const t of [this.pollTimer, this.expiryTimer]) {
      if (t) {
        clearInterval(t);
      }
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.pollTimer = this.expiryTimer = this.refreshTimer = null;
  }

  /** Read every device (and, if enabled, its power reading) and sync HomeKit. */
  async poll(initial = false): Promise<void> {
    if (this.polling || this.authFailed) {
      return;
    }
    this.polling = true;
    try {
      const devices = await this.client.getAllDevices();
      const stats = new Map<string, SmartGradeUsageStats | null>();
      if (this.exposePower) {
        await Promise.all([...devices.keys()].map(async (id) => {
          try {
            stats.set(id, await this.client.getLastUsageStats(id));
          } catch (err) {
            if (err instanceof SmartGradeAuthError) {
              throw err;
            }
            this.log.debug(`No usage stats for ${id}: ${(err as Error)?.message ?? err}`);
          }
        }));
      }
      this.sync(devices, stats, initial);
      if (this.lastErrorLogged) {
        this.log.info('Connection to the SmartGrade cloud restored.');
        this.lastErrorLogged = '';
      }
    } catch (err) {
      if (err instanceof SmartGradeAuthError) {
        this.authFailed = true;
        this.log.error(`⚠️ The SmartGrade cloud rejected the login (${err.message}). ${RELOGIN_HINT}`);
        this.stop();
      } else {
        const msg = (err as Error)?.message ?? String(err);
        if (msg !== this.lastErrorLogged) {
          this.log.warn(`Could not update from the SmartGrade cloud: ${msg} (will retry)`);
          this.lastErrorLogged = msg;
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private sync(devices: Map<string, SmartGradeDevice>, stats: Map<string, SmartGradeUsageStats | null>, initial: boolean): void {
    const seen = new Set<string>();
    for (const device of devices.values()) {
      const pid = productId(device);
      if (isShutterProduct(pid)) {
        if (initial) {
          this.log.info(
            `Skipping shutter "${device.name ?? device.id}" (${productName(pid)}): shutter control is not supported yet.`,
          );
          const shutterId = normalizeDeviceId(device.id);
          if ((this.config.devices ?? []).some((c) => normalizeDeviceId(c.id) === shutterId)) {
            this.log.info(
              `Ignoring device config for shutter "${device.name ?? device.id}": shutter control is not supported yet.`,
            );
          }
        }
        continue;
      }
      const count = relayCount(device);
      if (initial && count === 0) {
        this.log.info(`Skipping "${device.name ?? device.id}" (${productName(pid)}): no on/off relay.`);
      }
      for (let relay = 1; relay <= count; relay++) {
        const resolved = resolveRelay(device, relay, this.config.devices ?? []);
        if (resolved.hidden) {
          continue;
        }
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.id}:${relay}`);
        seen.add(uuid);
        let handler = this.handlers.get(uuid);
        if (handler) {
          if (handler.accessoryType !== resolved.accessoryType) {
            handler.configure(resolved);
          }
          handler.update(device, stats.get(device.id) ?? null);
          continue;
        }
        let accessory = this.cached.get(uuid);
        if (accessory) {
          this.log.info(`Restoring "${resolved.name}" as ${resolved.accessoryType}`);
          handler = new SmartGradeAccessory(this, accessory, device, resolved);
          this.api.updatePlatformAccessories([accessory]);
        } else {
          this.log.info(`Adding "${resolved.name}" as ${resolved.accessoryType}`);
          accessory = new this.api.platformAccessory<AccessoryContext>(resolved.name, uuid);
          handler = new SmartGradeAccessory(this, accessory, device, resolved);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.cached.set(uuid, accessory);
        }
        handler.update(device, stats.get(device.id) ?? null);
        this.handlers.set(uuid, handler);
      }
    }
    // Remove accessories of devices that disappeared or were hidden.
    const stale = [...this.cached.entries()].filter(([uuid]) => !seen.has(uuid));
    if (stale.length) {
      for (const [uuid, accessory] of stale) {
        this.log.info(`Removing "${accessory.displayName}"`);
        this.cached.delete(uuid);
        this.handlers.delete(uuid);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(([, a]) => a));
    }
  }

  /** AccessoryHost: send the relay command, then re-read the real state soon after. */
  async setRelay(deviceId: string, relay: number, on: boolean): Promise<void> {
    this.log.info(`Turning ${on ? 'on' : 'off'} ${deviceId} relay ${relay}`);
    try {
      await this.client.setSwitch(deviceId, on, relay);
    } catch (err) {
      if (err instanceof SmartGradeAuthError) {
        this.authFailed = true;
        this.log.error(`⚠️ The SmartGrade cloud rejected the login. ${RELOGIN_HINT}`);
      }
      throw err;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.poll(false), 3000);
    this.refreshTimer.unref?.();
  }

  /** For tests. */
  get accessoryHandlers(): SmartGradeAccessory[] {
    return [...this.handlers.values()];
  }
}
