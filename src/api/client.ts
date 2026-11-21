/**
 * Client for the SmartGrade Secure (IoTech Verticals / Dealor) cloud API.
 *
 * The API is undocumented. This is a TypeScript port of the client of the
 * sibling Home Assistant integration (sobelman/ha-smartgrade), whose behaviour
 * was reverse engineered from the official Android app and verified live.
 */
import { SmartGradeAuthError, SmartGradeConnectionError, SmartGradeRequestError } from './errors.js';
import { jwtExp } from './jwt.js';
import type {
  FetchLike,
  SmartGradeAction,
  SmartGradeDevice,
  SmartGradeLoginResult,
  SmartGradeSite,
  SmartGradeTimer,
  SmartGradeUsageStats,
} from './types.js';

export const BASE_URL = 'https://api.iotechv.com/';

/*
 * App-level credentials hardcoded in the official Android app (BuildConfig of
 * il.co.dealor). They are NOT user credentials: every copy of the app ships
 * with them, and they are only used for GET api/v1/apps/token, like the app.
 */
export const APP_USER = 'dealor_app';
export const APP_PASSWORD = 'J2AQHSrNXMkuv70UDh2F';

export const REQUEST_TIMEOUT_MS = 15_000;

const APP_BASIC = 'Basic ' + Buffer.from(`${APP_USER}:${APP_PASSWORD}`).toString('base64');

export interface SmartGradeApiOptions {
  jwt?: string | null;
  userId?: string | number | null;
  /** Injected fetch (tests pass a mock; defaults to the global fetch). */
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Normalise an Israeli mobile number to the verified `05XXXXXXXX` format.
 * Accepts spaces, dashes and the +972 / 972 prefixes.
 */
export function normalizeMobile(input: string): string {
  let digits = String(input ?? '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }
  if (digits.startsWith('972')) {
    digits = '0' + digits.slice(3);
  }
  return digits;
}

/** True for a plausible Israeli mobile number in 05XXXXXXXX form. */
export function isValidMobile(mobile: string): boolean {
  return /^05\d{8}$/.test(mobile);
}

export class SmartGradeApi {
  public jwt: string | null;
  public userId: string | number | null;
  private appToken: string | null = null;
  private appTokenExp = 0;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: SmartGradeApiOptions = {}) {
    this.jwt = options.jwt ?? null;
    this.userId = options.userId ?? null;
    this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** JWT expiry as epoch seconds (0 if unknown). */
  get jwtExpiresAt(): number {
    return jwtExp(this.jwt);
  }

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new SmartGradeConnectionError(`${init.method} ${url} failed: ${(err as Error)?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Return the app-level token, fetching a new one if within 1 h of expiry. */
  async getAppToken(): Promise<string> {
    if (this.appToken && this.appTokenExp > Date.now() / 1000 + 3600) {
      return this.appToken;
    }
    const resp = await this.send(this.baseUrl + 'api/v1/apps/token', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: APP_BASIC },
    });
    if (!resp.ok) {
      throw new SmartGradeConnectionError(`Cannot get app token: HTTP ${resp.status}`);
    }
    let data: any;
    try {
      data = JSON.parse(await resp.text());
    } catch {
      throw new SmartGradeConnectionError('Unexpected app token response');
    }
    const exp = Number(data?.exp);
    if (!data?.token || !Number.isFinite(exp)) {
      throw new SmartGradeConnectionError('Unexpected app token response');
    }
    this.appToken = String(data.token);
    this.appTokenExp = exp;
    return this.appToken;
  }

  /** Perform a request and return the decoded JSON body (or null). */
  async request(
    method: string,
    path: string,
    options: { user?: boolean; json?: unknown; params?: Record<string, string> } = {},
  ): Promise<any> {
    const user = options.user ?? true;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-APP-TOKEN': `Bearer ${await this.getAppToken()}`,
    };
    if (user) {
      if (!this.jwt) {
        throw new SmartGradeAuthError('Not logged in');
      }
      headers.Authorization = `Bearer ${this.jwt}`;
    }
    let url = this.baseUrl + path;
    if (options.params) {
      url += '?' + new URLSearchParams(options.params).toString();
    }
    const resp = await this.send(url, {
      method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new SmartGradeAuthError(`HTTP ${resp.status} on ${path}`);
    }
    if (!resp.ok) {
      throw new SmartGradeRequestError(resp.status, `${method} ${path} returned HTTP ${resp.status}`);
    }
    const text = await resp.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SmartGradeConnectionError(`Invalid JSON from ${path}`);
    }
  }

  // --- login (SMS one-time code) -----------------------------------------------

  /** Ask the cloud to send an SMS code. Returns true if accepted. */
  async requestSms(mobile: string): Promise<boolean> {
    let data: any;
    try {
      data = await this.request('POST', 'api/v1/customers', {
        user: false,
        json: { customer: { mobile: normalizeMobile(mobile) } },
      });
    } catch (err) {
      if (err instanceof SmartGradeRequestError && err.status >= 400 && err.status < 500) {
        return false;
      }
      throw err;
    }
    return Boolean(data && typeof data === 'object' && data.success);
  }

  /** Exchange the SMS code for a user JWT (valid for 30 days, no refresh). */
  async submitCode(code: string): Promise<SmartGradeLoginResult> {
    let data: any;
    try {
      data = await this.request('POST', 'api/v1/users/login/code', {
        user: false,
        json: { user: { code: String(code).trim() } },
      });
    } catch (err) {
      // A wrong or expired code is answered with a 4xx status.
      if (err instanceof SmartGradeRequestError && err.status >= 400 && err.status < 500) {
        throw new SmartGradeAuthError(err.message);
      }
      throw err;
    }
    if (!data || typeof data !== 'object' || !data.jwt) {
      throw new SmartGradeAuthError('No token in login response');
    }
    this.jwt = String(data.jwt);
    this.userId = data.user?.id ?? null;
    return { jwt: this.jwt, userId: this.userId };
  }

  // --- data ----------------------------------------------------------------------

  /** Return the user id, fetching the profile if needed. */
  async getUserId(): Promise<string | number> {
    if (!this.userId) {
      let profile = await this.request('GET', 'api/v1/users/profile');
      if (profile && typeof profile.user === 'object' && profile.user) {
        profile = profile.user;
      }
      if (!profile || typeof profile !== 'object' || profile.id === undefined) {
        throw new SmartGradeConnectionError('Unexpected profile response');
      }
      this.userId = profile.id;
    }
    return this.userId as string | number;
  }

  /** Return the sites (homes) of the user, including shared ones. */
  async getSites(): Promise<SmartGradeSite[]> {
    const userId = await this.getUserId();
    let data = await this.request('GET', `api/v1/users/${userId}/sites`, { params: { shared: 'true' } });
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data = data.sites;
    }
    return Array.isArray(data) ? data.filter((s) => s && typeof s === 'object') : [];
  }

  /**
   * Return the devices of a site with their live switch state.
   * Verified live: a bare JSON array. `{devices: [...]}` is accepted too.
   */
  async getSiteDevices(siteId: string | number): Promise<SmartGradeDevice[]> {
    let data = await this.request('GET', `api/v1/sites/${siteId}/devices`);
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data = data.devices;
    }
    return Array.isArray(data) ? data : [];
  }

  /** Return all devices of all sites keyed by device id. */
  async getAllDevices(): Promise<Map<string, SmartGradeDevice>> {
    const devices = new Map<string, SmartGradeDevice>();
    for (const site of await this.getSites()) {
      for (const device of await this.getSiteDevices(site.id)) {
        if (!device || typeof device !== 'object' || device.id === undefined || device.id === null) {
          continue;
        }
        const copy: SmartGradeDevice = { ...device, id: String(device.id) };
        copy.site_id ??= site.id;
        copy.site_name ??= site.name;
        devices.set(copy.id, copy);
      }
    }
    return devices;
  }

  /** Latest power reading: {volt, amper, watt, watt2, watt3, powerFactor, signalStrength, createdAt}. */
  async getLastUsageStats(deviceId: string): Promise<SmartGradeUsageStats | null> {
    const data = await this.request('GET', `api/v1/devices/${deviceId}/last_usage_stats`);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  }

  /** Timers of a device (read-only). */
  async getTimers(deviceId: string): Promise<SmartGradeTimer[]> {
    let data = await this.request('GET', `api/v1/devices/${deviceId}/timers`);
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data = data.timers;
    }
    return Array.isArray(data) ? data.filter((t) => t && typeof t === 'object') : [];
  }

  /** Next scheduled action {ts, switch_N, created_by}, or null (read-only). */
  async getNextAction(deviceId: string): Promise<SmartGradeAction | null> {
    let data: any;
    try {
      data = await this.request('GET', `api/v1/devices/${deviceId}/next_action`);
    } catch (err) {
      if (err instanceof SmartGradeRequestError && err.status === 404) {
        return null;
      }
      throw err;
    }
    if (data && typeof data.next_action === 'object' && data.next_action) {
      data = data.next_action;
    }
    if (!data || typeof data !== 'object' || data.ts === undefined || data.ts === null) {
      return null;
    }
    return data;
  }

  /** Upcoming scheduled actions (read-only). */
  async getFutureActions(deviceId: string): Promise<SmartGradeAction[]> {
    let data: any;
    try {
      data = await this.request('GET', `api/v1/devices/${deviceId}/future_actions`);
    } catch (err) {
      if (err instanceof SmartGradeRequestError && err.status === 404) {
        return [];
      }
      throw err;
    }
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data = data.future_actions ?? data.actions;
    }
    return Array.isArray(data) ? data.filter((a) => a && typeof a === 'object' && a.ts !== undefined && a.ts !== null) : [];
  }

  /**
   * Turn relay `relay` (1-3) of a device on or off.
   * The echoed body can contain a stale state, so it is ignored; callers must
   * re-read the device list to get the real state.
   */
  async setSwitch(deviceId: string, on: boolean, relay = 1): Promise<void> {
    if (!Number.isInteger(relay) || relay < 1 || relay > 3) {
      throw new RangeError(`Invalid relay ${relay}`);
    }
    await this.request('POST', `api/v1/devices/${deviceId}/toggle_switches`, {
      json: { [`switch_${relay}`]: on },
    });
  }
}
