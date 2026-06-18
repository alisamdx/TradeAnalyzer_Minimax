// Broker selection (Requirements/v2-execution §1.4, Phase 6).
//
// Chooses the ExecutionBroker implementation behind the seam. The default is the
// deterministic MockExecutionBroker — IBKR is strictly opt-in via env, so existing
// installs are unaffected until the operator points the engine at a live TWS/Gateway.
// Paper vs live only changes the *connection port*, never the engine or UI.

import type { ExecutionMode } from '../../shared/types.js';
import type { ExecutionBroker } from './execution-broker.js';
import { MockExecutionBroker } from './mock-execution-broker.js';
import { IbkrExecutionBroker } from './ibkr-execution-broker.js';

export interface BrokerSettings {
  kind: 'mock' | 'ibkr';
  host: string;
  port: number;
  clientId: number;
}

// TWS defaults; set TA_IBKR_GATEWAY=1 to use IB Gateway ports instead.
const TWS_PORTS = { paper: 7497, live: 7496 } as const;
const GATEWAY_PORTS = { paper: 4002, live: 4001 } as const;

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve broker settings from the engine's execution mode + environment. Pure and
 * unit-tested. Precedence for the port: TA_IBKR_PORT (explicit) → Gateway/TWS table
 * keyed by mode. The IBKR adapter is selected only when TA_EXEC_BROKER=ibkr.
 */
export function resolveBrokerSettings(mode: ExecutionMode, env: EnvLike = process.env): BrokerSettings {
  const kind = (env.TA_EXEC_BROKER ?? 'mock').toLowerCase() === 'ibkr' ? 'ibkr' : 'mock';
  const useGateway = env.TA_IBKR_GATEWAY === '1' || (env.TA_IBKR_GATEWAY ?? '').toLowerCase() === 'true';
  const table = useGateway ? GATEWAY_PORTS : TWS_PORTS;
  const explicitPort = env.TA_IBKR_PORT ? Number(env.TA_IBKR_PORT) : null;
  const port = explicitPort && Number.isFinite(explicitPort) ? explicitPort : table[mode];
  const clientId = env.TA_IBKR_CLIENT_ID ? Number(env.TA_IBKR_CLIENT_ID) : 7;
  return { kind, host: env.TA_IBKR_HOST ?? '127.0.0.1', port, clientId };
}

/** Construct the chosen broker. Construction never opens a connection (the core calls connect()). */
export function createExecutionBroker(settings: BrokerSettings): ExecutionBroker {
  if (settings.kind === 'ibkr') {
    return new IbkrExecutionBroker({ host: settings.host, port: settings.port, clientId: settings.clientId });
  }
  return new MockExecutionBroker();
}
