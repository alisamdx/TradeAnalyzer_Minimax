// Broker selection (Requirements/v2-execution §1.4 + 07-broker-alternatives §3).
//
// Chooses the ExecutionBroker implementation behind the seam. Selection is now
// SETTINGS-DRIVEN (per-mode paper_broker/live_broker in exec_config), with the legacy
// TA_EXEC_BROKER env kept as an explicit override for dev/tests. Paper vs live picks
// which slot's broker runs AND the connection target (IBKR port / Tradier sandbox-vs-prod).
//
// The default remains the deterministic MockExecutionBroker — both config columns default to
// 'mock', so an install that never picks a broker is unaffected.

import type { ExecutionMode, ExecBrokerKind } from '../../shared/types.js';
import type { ExecutionBroker } from './execution-broker.js';
import { MockExecutionBroker } from './mock-execution-broker.js';
import { IbkrExecutionBroker } from './ibkr-execution-broker.js';
import { TradierExecutionBroker } from './tradier-execution-broker.js';

export interface BrokerSettings {
  kind: ExecBrokerKind;
  // ── ibkr ──
  host: string;
  port: number;
  clientId: number;
  // ── tradier ──
  tradier: {
    env: 'sandbox' | 'production'; // paper → sandbox, live → production
    baseUrl: string;
    token: string | null; // Bearer access token (env stopgap until secure-settings UI lands)
    accountId: string | null;
  };
}

// TWS defaults; set TA_IBKR_GATEWAY=1 to use IB Gateway ports instead.
const TWS_PORTS = { paper: 7497, live: 7496 } as const;
const GATEWAY_PORTS = { paper: 4002, live: 4001 } as const;
// Tradier hosts: sandbox is the real paper environment, production is real money. One REST API.
const TRADIER_BASE = { paper: 'https://sandbox.tradier.com', live: 'https://api.tradier.com' } as const;

type EnvLike = Record<string, string | undefined>;

/** Per-mode broker choice from persisted config (the part of ExecConfig the factory needs). */
export interface BrokerConfig {
  paperBroker: ExecBrokerKind;
  liveBroker: ExecBrokerKind;
}

function asKind(s: string | undefined | null): ExecBrokerKind | null {
  const v = (s ?? '').toLowerCase();
  return v === 'ibkr' || v === 'tradier' || v === 'mock' ? v : null;
}

/**
 * Resolve the active broker kind. Precedence:
 *   1. explicit TA_EXEC_BROKER env (override, for dev/tests)
 *   2. exec_config.{paper,live}_broker by mode
 *   3. 'mock' (safe default — never auto-connects a real venue)
 */
function resolveKind(mode: ExecutionMode, env: EnvLike, config?: BrokerConfig): ExecBrokerKind {
  return (
    asKind(env.TA_EXEC_BROKER) ??
    (mode === 'live' ? config?.liveBroker : config?.paperBroker) ??
    'mock'
  );
}

/**
 * Resolve broker settings from execution mode + environment (+ optional persisted config). Pure and
 * unit-tested. IBKR port precedence: TA_IBKR_PORT (explicit) → Gateway/TWS table keyed by mode.
 * Tradier base URL is fixed by mode (sandbox/production); token/account come from env for now.
 */
export function resolveBrokerSettings(
  mode: ExecutionMode,
  env: EnvLike = process.env,
  config?: BrokerConfig
): BrokerSettings {
  const kind = resolveKind(mode, env, config);

  const useGateway = env.TA_IBKR_GATEWAY === '1' || (env.TA_IBKR_GATEWAY ?? '').toLowerCase() === 'true';
  const table = useGateway ? GATEWAY_PORTS : TWS_PORTS;
  const explicitPort = env.TA_IBKR_PORT ? Number(env.TA_IBKR_PORT) : null;
  const port = explicitPort && Number.isFinite(explicitPort) ? explicitPort : table[mode];
  const clientId = env.TA_IBKR_CLIENT_ID ? Number(env.TA_IBKR_CLIENT_ID) : 7;

  const tradierEnv: 'sandbox' | 'production' = mode === 'live' ? 'production' : 'sandbox';
  return {
    kind,
    host: env.TA_IBKR_HOST ?? '127.0.0.1',
    port,
    clientId,
    tradier: {
      env: tradierEnv,
      baseUrl: env.TA_TRADIER_BASE_URL ?? TRADIER_BASE[mode],
      // Distinct tokens per environment; fall back to a single TA_TRADIER_TOKEN if set.
      token:
        (tradierEnv === 'production' ? env.TA_TRADIER_TOKEN_PROD : env.TA_TRADIER_TOKEN_SANDBOX) ??
        env.TA_TRADIER_TOKEN ??
        null,
      accountId: env.TA_TRADIER_ACCOUNT_ID ?? null,
    },
  };
}

/** Construct the chosen broker. Construction never opens a connection (the core calls connect()). */
export function createExecutionBroker(settings: BrokerSettings): ExecutionBroker {
  if (settings.kind === 'ibkr') {
    return new IbkrExecutionBroker({ host: settings.host, port: settings.port, clientId: settings.clientId });
  }
  if (settings.kind === 'tradier') {
    return new TradierExecutionBroker({
      baseUrl: settings.tradier.baseUrl,
      env: settings.tradier.env,
      token: settings.tradier.token,
      accountId: settings.tradier.accountId,
    });
  }
  return new MockExecutionBroker();
}
