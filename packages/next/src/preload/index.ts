import { contextBridge, ipcRenderer } from 'electron';
import type { NextApi, QueryRequestDto } from '../shared/types.js';

/**
 * The context-isolated bridge. 05 §9 specifies the full `window.api` surface;
 * this is what B6 needs.
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
  },
  chains: {
    dates: () => ipcRenderer.invoke('chains:dates'),
    tickers: (asOfDate: string) => ipcRenderer.invoke('chains:tickers', asOfDate),
    expirations: (ticker: string, asOfDate: string) =>
      ipcRenderer.invoke('chains:expirations', ticker, asOfDate),
    grid: (ticker: string, asOfDate: string, expirationDate: string) =>
      ipcRenderer.invoke('chains:grid', ticker, asOfDate, expirationDate),
    contractHistory: (osiSymbol: string) => ipcRenderer.invoke('chains:contract-history', osiSymbol)
  },
  account: {
    snapshotDates: () => ipcRenderer.invoke('account:snapshot-dates'),
    positions: (asOfDate: string) => ipcRenderer.invoke('account:positions', asOfDate),
    orders: (limit?: number) => ipcRenderer.invoke('account:orders', limit),
    balances: () => ipcRenderer.invoke('account:balances')
  },
  earnings: {
    months: () => ipcRenderer.invoke('earnings:months'),
    month: (month: string) => ipcRenderer.invoke('earnings:month', month),
    trail: (ticker: string) => ipcRenderer.invoke('earnings:trail', ticker),
    anomalies: () => ipcRenderer.invoke('earnings:anomalies')
  },
  volatility: {
    tickers: () => ipcRenderer.invoke('iv:tickers'),
    series: (ticker: string) => ipcRenderer.invoke('iv:series', ticker)
  },
  legacy: {
    summary: () => ipcRenderer.invoke('legacy:summary'),
    runs: () => ipcRenderer.invoke('legacy:runs'),
    candidates: (runId: string) => ipcRenderer.invoke('legacy:candidates', runId)
  }
};

contextBridge.exposeInMainWorld('api', api);
