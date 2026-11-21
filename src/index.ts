import type { API } from 'homebridge';

import { SmartGradePlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/** Registers the SmartGrade dynamic platform with Homebridge. */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SmartGradePlatform);
};
