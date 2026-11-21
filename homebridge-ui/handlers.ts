/**
 * Request handlers of the custom settings UI, kept separate from the
 * HomebridgePluginUiServer wiring so they can be unit-tested with a mocked
 * fetch. These are the only code paths that talk to the vendor cloud for the
 * login, and only when the user presses the buttons in the Homebridge UI.
 */
import { SmartGradeApi, isValidMobile, normalizeMobile } from '../src/api/client.js';
import { SmartGradeAuthError, SmartGradeError } from '../src/api/errors.js';
import { tokenStatus, type TokenStatus } from '../src/api/jwt.js';
import type { FetchLike, SmartGradeDevice } from '../src/api/types.js';
import { summarizeDevice, type DeviceSummary } from '../src/deviceInfo.js';

/** Error with a message that is safe to show in the UI. */
export class UiError extends Error {}

export interface UiHandlers {
  status(payload: { jwt?: string }): TokenStatus;
  sendSms(payload: { mobile?: string }): Promise<{ sent: true; mobile: string }>;
  submitCode(payload: { code?: string }): Promise<{ jwt: string; userId: string | number | null; status: TokenStatus }>;
  devices(payload: { jwt?: string; userId?: string | number }): Promise<{ devices: DeviceSummary[] }>;
}

function friendly(err: unknown, fallback: string): never {
  if (err instanceof UiError) {
    throw err;
  }
  if (err instanceof SmartGradeAuthError) {
    throw new UiError('The code was rejected or has expired. Request a new SMS and try again.');
  }
  if (err instanceof SmartGradeError) {
    throw new UiError(`${fallback}: ${err.message}`);
  }
  throw new UiError(fallback);
}

export function createUiHandlers(fetchImpl?: FetchLike): UiHandlers {
  // One client for the whole login, so the SMS request and the code submit
  // share the same app token, exactly like the official app.
  const loginClient = new SmartGradeApi({ fetch: fetchImpl });

  return {
    status({ jwt }) {
      return tokenStatus(jwt);
    },

    async sendSms({ mobile }) {
      const normalized = normalizeMobile(mobile ?? '');
      if (!isValidMobile(normalized)) {
        throw new UiError('Enter an Israeli mobile number, e.g. 05XXXXXXXX.');
      }
      try {
        if (!(await loginClient.requestSms(normalized))) {
          throw new UiError('The SmartGrade cloud did not accept this number. Is it the number registered in the Dealor app?');
        }
      } catch (err) {
        friendly(err, 'Could not request the SMS');
      }
      return { sent: true, mobile: normalized };
    },

    async submitCode({ code }) {
      const clean = String(code ?? '').trim();
      if (!/^\d{3,8}$/.test(clean)) {
        throw new UiError('Enter the numeric code from the SMS.');
      }
      try {
        const result = await loginClient.submitCode(clean);
        return { jwt: result.jwt, userId: result.userId, status: tokenStatus(result.jwt) };
      } catch (err) {
        friendly(err, 'Login failed');
      }
    },

    async devices({ jwt, userId }) {
      if (!jwt) {
        throw new UiError('Log in first.');
      }
      const client = new SmartGradeApi({ jwt, userId: userId ?? null, fetch: fetchImpl });
      let devices: Map<string, SmartGradeDevice>;
      try {
        devices = await client.getAllDevices();
      } catch (err) {
        if (err instanceof SmartGradeAuthError) {
          throw new UiError('The saved login is no longer valid. Log in again with a new SMS code.');
        }
        friendly(err, 'Could not load devices');
      }
      // Read-only extras; a failure here never hides the device.
      const summaries = await Promise.all([...devices.values()].map(async (device) => {
        const [stats, timers, next, future] = await Promise.all([
          client.getLastUsageStats(device.id).catch(() => null),
          Array.isArray(device.timers) ? Promise.resolve(device.timers) : client.getTimers(device.id).catch(() => []),
          client.getNextAction(device.id).catch(() => null),
          client.getFutureActions(device.id).catch(() => []),
        ]);
        return summarizeDevice(device, { stats, timers, next, future });
      }));
      return { devices: summaries };
    },
  };
}
