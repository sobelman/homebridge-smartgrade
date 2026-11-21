/**
 * Test helpers. Everything here is offline: the API client gets an injected
 * mock fetch, and the global fetch is replaced by one that throws, so a test
 * can never reach the real vendor cloud.
 */
import * as hap from '@homebridge/hap-nodejs';

import type { FetchLike } from '../src/api/types.js';

(globalThis as any).fetch = async (url: unknown) => {
  throw new Error(`Real network access is forbidden in tests (tried ${String(url)})`);
};

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export type Route = {
  method: string;
  /** Path after the base URL, without the query string. */
  path: string | RegExp;
  status?: number;
  body?: unknown;
  /** Raw response text (overrides body). */
  text?: string;
};

/** A fetch mock that answers from a route table and records every call. */
export function mockFetch(routes: Route[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    const method = init.method ?? 'GET';
    calls.push({ method, url, path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    if (!route) {
      return { status: 404, ok: false, text: async () => '' };
    }
    const status = route.status ?? 200;
    const text = route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body));
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { fetch, calls };
}

export const APP_TOKEN_ROUTE: Route = {
  method: 'GET',
  path: 'api/v1/apps/token',
  body: { token: 'test-app-token', exp: 2_300_000_000 },
};

/** Unsigned fake JWT with the given exp (NOT a real token). */
export function fakeJwt(expSeconds: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'test-user', exp: expSeconds })}.fake-signature`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Fictional devices (ids are made up, not real hardware). */
export const BOILER = {
  id: 'aabbccddeeff',
  name: 'Test boiler',
  product_id: 8,
  firmware: '20260101_var2_v2.9.2',
  is_online: true,
  switch_num: 1,
  switch_1: false,
  switch_1_name: null,
  max_on_min: 120,
  upgradeNow: false,
};

export const TRIPLE_LIGHT = {
  id: '112233445566',
  name: 'Hall lights',
  product_id: 9,
  firmware: 'v1.4',
  is_online: true,
  switch_num: 3,
  switch_1: true,
  switch_2: false,
  switch_3: true,
  switch_1_name: 'Ceiling',
  switch_2_name: 'Wall',
  switch_3_name: null,
};

export const SITE_ROUTES = (devices: unknown[]): Route[] => [
  APP_TOKEN_ROUTE,
  { method: 'GET', path: 'api/v1/users/42/sites', body: [{ id: 7, name: 'Home' }] },
  { method: 'GET', path: 'api/v1/sites/7/devices', body: devices },
];

/** A stand-in for Homebridge's PlatformAccessory built on a real HAP Accessory. */
export class FakePlatformAccessory {
  public readonly hapAccessory: hap.Accessory;
  public context: Record<string, unknown> = {};
  constructor(public displayName: string, public readonly UUID: string) {
    this.hapAccessory = new hap.Accessory(displayName, UUID);
  }

  get services() {
    return this.hapAccessory.services;
  }

  getService(s: any) {
    return this.hapAccessory.getService(s);
  }

  addService(s: any, ...args: any[]) {
    return this.hapAccessory.addService(s, ...args);
  }

  removeService(s: any) {
    this.hapAccessory.removeService(s);
  }
}

export function fakeLog() {
  const lines: string[] = [];
  const add = (level: string) => (msg: string) => lines.push(`${level}: ${msg}`);
  const log: any = Object.assign(add('log'), {
    info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug'), success: add('success'), log: add('log'),
  });
  return { log, lines };
}

export function fakeApi() {
  const listeners: Record<string, (() => void)[]> = {};
  const registered: FakePlatformAccessory[] = [];
  const unregistered: FakePlatformAccessory[] = [];
  const api: any = {
    hap,
    platformAccessory: FakePlatformAccessory,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
    },
    registerPlatformAccessories(_p: string, _n: string, list: FakePlatformAccessory[]) {
      registered.push(...list);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories(_p: string, _n: string, list: FakePlatformAccessory[]) {
      unregistered.push(...list);
    },
  };
  return { api, listeners, registered, unregistered, hap };
}
