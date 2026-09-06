import { contextBridge } from 'electron';
import type { NextApi } from './api.js';

/**
 * The context-isolated bridge. 05 §9 specifies the full `window.api` surface;
 * at B1 it carries only what proves the bridge is wired.
 */
const api: NextApi = {
  appVersion: process.env['npm_package_version'] ?? null,
  platform: process.platform
};

contextBridge.exposeInMainWorld('api', api);
