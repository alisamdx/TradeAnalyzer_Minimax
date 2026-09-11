import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DeepLinkRoute } from '../shared/deeplink.js';
import type {
  ExceptionFilterDto, NextApi, QueryRequestDto, QuestionDefinitionDto, ResolutionHowDto
} from '../shared/types.js';

/**
 * The context-isolated bridge. 05 §9 specifies the full `window.api` surface;
 * this is what B9c needs.
 *
 * The renderer gets named methods, never a general `invoke(channel, ...)`.
 * A generic passthrough would make the renderer able to reach any handler the
 * main process ever registers, which is precisely what context isolation is for.
 */
const api: NextApi = {
  appVersion: process.env['npm_package_version'] ?? null,
  platform: process.platform,
  generation: {
    current: () => ipcRenderer.invoke('generation:current'),
    list: () => ipcRenderer.invoke('generation:list'),
    openReadOnly: (generationNo: number) => ipcRenderer.invoke('generation:open-readonly', generationNo)
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
  questions: {
    list: (table: string | null) => ipcRenderer.invoke('questions:list', table),
    save: (name: string, table: string, definition: QuestionDefinitionDto, note: string | null) =>
      ipcRenderer.invoke('questions:save', name, table, definition, note),
    retire: (id: number) => ipcRenderer.invoke('questions:retire', id)
  },
  chains: {
    dates: () => ipcRenderer.invoke('chains:dates'),
    tickers: (asOfDate: string) => ipcRenderer.invoke('chains:tickers', asOfDate),
    expirations: (ticker: string, asOfDate: string) =>
      ipcRenderer.invoke('chains:expirations', ticker, asOfDate),
    grid: (ticker: string, asOfDate: string, expirationDate: string) =>
      ipcRenderer.invoke('chains:grid', ticker, asOfDate, expirationDate),
    contractHistory: (osiSymbol: string) => ipcRenderer.invoke('chains:contract-history', osiSymbol),
    pins: (osiSymbol: string) => ipcRenderer.invoke('chains:pins', osiSymbol),
    pin: (osiSymbol: string, note: string) => ipcRenderer.invoke('chains:pin', osiSymbol, note),
    unpin: (osiSymbol: string, note: string) => ipcRenderer.invoke('chains:unpin', osiSymbol, note)
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
  },
  exceptions: {
    list: (filter: ExceptionFilterDto) => ipcRenderer.invoke('exceptions:list', filter),
    detail: (id: number) => ipcRenderer.invoke('exceptions:detail', id),
    acknowledge: (id: number, note: string | null) => ipcRenderer.invoke('exceptions:acknowledge', id, note),
    bulkAcknowledge: (ids: readonly number[], note: string | null) =>
      ipcRenderer.invoke('exceptions:bulk-acknowledge', ids, note),
    resolve: (id: number, how: ResolutionHowDto, note: string) =>
      ipcRenderer.invoke('exceptions:resolve', id, how, note),
    accept: (id: number, note: string, until: string | null) =>
      ipcRenderer.invoke('exceptions:accept', id, note, until),
    recordReuse: (id: number, ticker: string, spliceDate: string | null, note: string) =>
      ipcRenderer.invoke('exceptions:record-reuse', id, ticker, spliceDate, note),
    zeroFire: () => ipcRenderer.invoke('exceptions:zero-fire')
  },
  runs: {
    list: () => ipcRenderer.invoke('runs:list'),
    detail: (runId: number) => ipcRenderer.invoke('runs:detail', runId)
  },
  jobs: {
    overview: () => ipcRenderer.invoke('jobs:overview'),
    queue: (kind, params) => ipcRenderer.invoke('jobs:queue', kind, params ?? null),
    cancel: (requestId: number) => ipcRenderer.invoke('jobs:cancel', requestId),
    resetPreview: () => ipcRenderer.invoke('jobs:reset-preview'),
    reset: (reason: string, confirmation: string) => ipcRenderer.invoke('jobs:reset', reason, confirmation)
  },
  deepLinks: {
    initial: () => ipcRenderer.invoke('deeplink:initial'),
    // A subscription, and the only push channel in the bridge. It carries a
    // place to go and nothing else — the route type has no way to express an
    // action (05 §11.1).
    onNavigate: (listener: (route: DeepLinkRoute) => void) => {
      const forward = (_event: IpcRendererEvent, route: DeepLinkRoute): void => listener(route);
      ipcRenderer.on('deeplink:navigate', forward);
      return () => {
        ipcRenderer.removeListener('deeplink:navigate', forward);
      };
    }
  }
};

contextBridge.exposeInMainWorld('api', api);
