import { contextBridge, ipcRenderer } from 'electron';
import type { NextApi, QueryRequestDto } from '../shared/types.js';

/**
 * The context-isolated bridge. 05 §9 specifies the full `window.api` surface;
 * this is what B2 needs.
 *
 * The renderer gets named methods, never a general `invoke(channel, ...)`.
 * A generic passthrough would make the renderer able to reach any handler the
 * main process ever registers, which is precisely what context isolation is for.
 */
const api: NextApi = {
  appVersion: process.env['npm_package_version'] ?? null,
  platform: process.platform,
  generation: {
    current: () => ipcRenderer.invoke('generation:current')
  },
  dictionary: {
    tables: () => ipcRenderer.invoke('dictionary:tables'),
    tree: () => ipcRenderer.invoke('dictionary:tree'),
    columns: (table: string) => ipcRenderer.invoke('dictionary:columns', table),
    stats: (table: string) => ipcRenderer.invoke('dictionary:stats', table),
    unverified: () => ipcRenderer.invoke('dictionary:unverified')
  },
  inspect: {
    query: (req: QueryRequestDto) => ipcRenderer.invoke('inspect:query', req)
  }
};

contextBridge.exposeInMainWorld('api', api);
