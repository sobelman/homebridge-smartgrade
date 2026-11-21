import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { UiError, createUiHandlers } from './handlers.js';

/**
 * Server side of the custom settings screen. The browser part
 * (public/index.html) calls these routes; the resulting JWT is written to the
 * plugin config by the browser via homebridge.updatePluginConfig().
 */
class SmartGradeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const handlers = createUiHandlers();
    const wrap = <T>(fn: (payload: any) => Promise<T> | T) => async (payload: any) => {
      try {
        return await fn(payload ?? {});
      } catch (err) {
        const message = err instanceof UiError ? err.message : 'Unexpected error';
        throw new RequestError(message, { message });
      }
    };
    this.onRequest('/status', wrap(handlers.status));
    this.onRequest('/send-sms', wrap(handlers.sendSms));
    this.onRequest('/submit-code', wrap(handlers.submitCode));
    this.onRequest('/devices', wrap(handlers.devices));
    this.ready();
  }
}

(() => new SmartGradeUiServer())();
