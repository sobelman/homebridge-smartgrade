/** Platform name used in the Homebridge config.json (`"platform": "SmartGrade"`). */
export const PLATFORM_NAME = 'SmartGrade';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-smartgrade';

export const MANUFACTURER = 'IoTech Verticals (Dealor)';

export const DEFAULT_POLL_INTERVAL = 30;
export const MIN_POLL_INTERVAL = 15;

export type AccessoryType = 'switch' | 'outlet' | 'valve';
export type ValveKind = 'generic' | 'faucet';

export const ACCESSORY_TYPES: readonly AccessoryType[] = ['switch', 'outlet', 'valve'];

/** One entry of the per-device list in config.json. */
export interface DeviceConfig {
  /** Device id as shown in the plugin settings (12 hex digits). */
  id: string;
  /** Only this relay (1-3). Omit to apply to every relay of the device. */
  relay?: number;
  /** HomeKit name override. */
  name?: string;
  accessoryType?: AccessoryType;
  /** Valve icon: generic valve or water faucet. */
  valveType?: ValveKind;
  /** Do not expose this device/relay to HomeKit. */
  hidden?: boolean;
}

export interface SmartGradePlatformConfig {
  platform: string;
  name?: string;
  /** 30-day user JWT, written by the custom settings UI after the SMS login. */
  jwt?: string;
  userId?: string | number;
  /** Saved by the settings UI to prefill the next login. */
  mobile?: string;
  pollInterval?: number;
  /** Add Eve power / current / voltage characteristics (read-only). */
  exposePower?: boolean;
  devices?: DeviceConfig[];
}
