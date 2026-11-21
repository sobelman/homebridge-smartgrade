import type { SmartGradeAction, SmartGradeDevice, SmartGradeTimer, SmartGradeUsageStats } from './api/types.js';
import { PRODUCTS, deviceMac, productId, productName, relayCount, suggestedAccessoryType, SHUTTER_PRODUCTS } from './products.js';
import type { AccessoryType } from './settings.js';

/** Readable fields of one timer (read-only; never its raw internals). */
export interface TimerSummary {
  name: string | null;
  enabled: boolean;
  kind: string | null;
  days: unknown;
  switches: number[];
  [key: string]: unknown;
}

export function summarizeTimer(timer: SmartGradeTimer): TimerSummary {
  const detail = (timer.timer_detail && typeof timer.timer_detail === 'object' ? timer.timer_detail : {}) as Record<string, unknown>;
  const summary: TimerSummary = {
    name: (timer.name as string | null | undefined) ?? null,
    enabled: Boolean(timer.is_enabled),
    kind: (timer.timer_kind as string | null | undefined) ?? null,
    days: detail.days ?? null,
    switches: [1, 2, 3].filter((n) => detail[`switch_${n}`] !== undefined && detail[`switch_${n}`] !== null),
  };
  for (const key of ['on_time', 'off_time', 'on_minutes', 'off_minutes', 'start_period', 'stop_period', 'from_date', 'to_date']) {
    if (detail[key] !== undefined && detail[key] !== null) {
      summary[key] = detail[key];
    }
  }
  return summary;
}

/** Epoch seconds or milliseconds -> epoch milliseconds, or null. */
export function actionTimeMs(ts: unknown): number | null {
  const n = Number(ts);
  if (ts === null || ts === undefined || ts === '' || !Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n > 1e12 ? n : n * 1000;
}

export interface UpcomingAction {
  time: string;
  action: 'on' | 'off' | 'mixed' | null;
  switches: Record<string, boolean>;
}

/** Merge next_action + future_actions into future-only, de-duplicated, soonest first. */
export function upcomingActions(next: SmartGradeAction | null, future: SmartGradeAction[], nowMs = Date.now()): UpcomingAction[] {
  const all = [...future, ...(next ? [next] : [])];
  const seen = new Set<string>();
  const out: UpcomingAction[] = [];
  for (const action of all.sort((a, b) => (actionTimeMs(a.ts) ?? 0) - (actionTimeMs(b.ts) ?? 0))) {
    const ms = actionTimeMs(action.ts);
    if (ms === null || ms < nowMs - 60_000) {
      continue;
    }
    const switches: Record<string, boolean> = {};
    for (const n of [1, 2, 3]) {
      const v = action[`switch_${n}`];
      if (v !== undefined && v !== null) {
        switches[`switch_${n}`] = Boolean(v);
      }
    }
    const key = `${ms}:${JSON.stringify(switches)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const values = new Set(Object.values(switches));
    const word = values.size === 0 ? null : values.size > 1 ? 'mixed' : values.has(true) ? 'on' : 'off';
    out.push({ time: new Date(ms).toISOString(), action: word, switches });
  }
  return out;
}

/** Everything the settings UI shows about one device (no account details). */
export interface DeviceSummary {
  id: string;
  name: string;
  site: string | null;
  location: string | null;
  productId: number | null;
  model: string;
  modelHebrew: string | null;
  mac: string | null;
  firmware: string | null;
  upgradePending: boolean | null;
  online: boolean | null;
  relays: { relay: number; name: string | null; on: boolean | null }[];
  maxOnMinutes: number | null;
  suggestedType: AccessoryType;
  isShutter: boolean;
  power: { watt: number | null; amper: number | null; volt: number | null; signalStrength: number | null; at: unknown } | null;
  timers: TimerSummary[];
  upcoming: UpcomingAction[];
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

export function summarizeDevice(
  device: SmartGradeDevice,
  extra: {
    stats?: SmartGradeUsageStats | null;
    timers?: SmartGradeTimer[];
    next?: SmartGradeAction | null;
    future?: SmartGradeAction[];
  } = {},
): DeviceSummary {
  const pid = productId(device);
  const count = relayCount(device);
  const timers = extra.timers ?? (Array.isArray(device.timers) ? device.timers : []);
  return {
    id: device.id,
    name: device.name ?? device.id,
    site: (device.site_name as string | undefined) ?? null,
    location: (device.location as string | null | undefined) ?? null,
    productId: pid,
    model: productName(pid),
    modelHebrew: pid !== null && PRODUCTS[pid] ? PRODUCTS[pid][1] : null,
    mac: deviceMac(device.id),
    firmware: device.firmware ?? null,
    upgradePending: typeof device.upgradeNow === 'boolean' ? device.upgradeNow : null,
    online: typeof device.is_online === 'boolean' ? device.is_online : null,
    relays: Array.from({ length: count }, (_, i) => ({
      relay: i + 1,
      name: (device[`switch_${i + 1}_name`] as string | null | undefined) ?? null,
      on: typeof device[`switch_${i + 1}`] === 'boolean' ? (device[`switch_${i + 1}`] as boolean) : null,
    })),
    maxOnMinutes: num(device.max_on_min),
    suggestedType: suggestedAccessoryType(pid),
    isShutter: pid !== null && SHUTTER_PRODUCTS.has(pid),
    power: extra.stats
      ? {
        watt: num(extra.stats.watt),
        amper: num(extra.stats.amper),
        volt: num(extra.stats.volt),
        signalStrength: num(extra.stats.signalStrength),
        at: extra.stats.createdAt ?? null,
      }
      : null,
    timers: timers.map(summarizeTimer),
    upcoming: upcomingActions(extra.next ?? null, extra.future ?? []).slice(0, 10),
  };
}
