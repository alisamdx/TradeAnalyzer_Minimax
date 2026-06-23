// The execution control API (Requirements/v2-execution §1.6).
//
// A Fastify server on 127.0.0.1:7433 that the Electron control panel talks to — separate
// from the v1 agent API (:7432) so it is reachable when the app window is closed. It wraps
// the ExecutionCore + RiskGovernor: engine control, state/config/positions/audit reads, the
// brief-ready handoff, and an SSE stream of the core's events. Token-authed (X-Agent-Token)
// reusing ~/.tradeanalyzer/agent.token.

import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { DbHandle } from '../db/connection.js';
import type { ExecEngineStateView } from '../../shared/types.js';
import type { RiskGovernor } from './risk-governor.js';
import type { ExecutionCore, CoreEvent } from './execution-core.js';

const DATA_DIR = join(homedir(), '.tradeanalyzer');

function readAgentToken(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const tokenPath = join(DATA_DIR, 'agent.token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

/** Format a core event as an SSE frame. */
export function formatSse(event: CoreEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface ControlApiOptions {
  db: DbHandle;
  core: ExecutionCore;
  governor: RiskGovernor;
  token?: string; // default: read/create the agent token
  /** Phase 4 wires entry-proposal generation here; absent for now. */
  onBriefReady?: () => Promise<void> | void;
  /** Which broker the engine was assembled with (mock vs ibkr) — surfaced on /exec/state. */
  brokerKind?: string;
  /** The engine facade's full state view (adds automationMode + armed + drawdownPct over the
   *  core/governor-derived shape). When present, /exec/state returns it (plus broker). */
  getStateView?: () => ExecEngineStateView;
}

export class ExecutionControlApi {
  private readonly fastify: FastifyInstance = Fastify({ logger: false });
  private readonly token: string;

  constructor(private readonly opts: ControlApiOptions) {
    this.token = opts.token ?? readAgentToken();
    this.registerRoutes();
  }

  /** For tests — delegate to fastify.inject. */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return this.fastify.inject(opts);
  }

  async start(port = 7433): Promise<void> {
    await this.fastify.listen({ port, host: '127.0.0.1' });
  }

  async stop(): Promise<void> {
    await this.fastify.close();
  }

  private registerRoutes(): void {
    const { fastify } = this;
    const { db, core, governor } = this.opts;

    // Token auth on everything except the public health probe.
    fastify.addHook('onRequest', async (req, reply) => {
      if (req.url === '/exec/health') return;
      if ((req.headers['x-agent-token'] ?? '') !== this.token) {
        await reply.code(401).send({ ok: false, error: 'unauthorized' });
      }
    });

    fastify.get('/exec/health', async () => ({ ok: true }));

    fastify.get('/exec/state', async () => {
      const broker = this.opts.brokerKind ?? 'mock';
      // Prefer the engine facade's view (adds automationMode + armed + drawdownPct) when wired.
      if (this.opts.getStateView) {
        return { ...this.opts.getStateView(), broker };
      }
      const rs = governor.getRiskState();
      return {
        engineState: rs.engineState,
        killSwitch: { tripped: rs.killSwitchTripped, reason: rs.killSwitchReason },
        executionMode: governor.getConfig().executionMode,
        broker,
        health: core.getHealth(),
      };
    });

    fastify.get('/exec/config', async () => governor.getConfig());
    fastify.get('/exec/risk', async () => governor.getRiskState());

    fastify.post('/exec/engine/start', async () => core.startEngine());
    fastify.post('/exec/engine/stop', async () => {
      core.stopEngine();
      return { engineState: governor.getEngineState() };
    });
    fastify.post('/exec/engine/pause', async (_req, reply) => {
      try {
        core.pauseEngine();
        return { engineState: governor.getEngineState() };
      } catch (err) {
        return reply.code(409).send({ ok: false, error: (err as Error).message });
      }
    });

    fastify.post('/exec/kill-switch/trip', async () => {
      governor.tripKillSwitch('manual');
      return { engineState: governor.getEngineState() };
    });
    fastify.post('/exec/kill-switch/clear', async () => {
      governor.clearKillSwitch();
      return { engineState: governor.getEngineState() };
    });

    fastify.get('/exec/positions', async () => {
      return db
        .prepare(
          `SELECT id, ticker, strategy, structure, contracts, max_loss, entry_net_credit,
                  current_mark, current_pnl, status, opened_at
           FROM exec_positions WHERE status != 'closed' ORDER BY opened_at DESC`
        )
        .all();
    });

    fastify.get<{ Querystring: { limit?: string } }>('/exec/audit', async (req) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1), 1000);
      return db.prepare('SELECT id, at, event, ref_table, ref_id, detail_json FROM exec_audit_log ORDER BY id DESC LIMIT ?').all(limit);
    });

    // Zero-latency handoff: the brief job pings this when fresh picks are committed (§1.3b).
    fastify.post('/exec/brief-ready', async () => {
      governor.audit('brief_ready', { detail: { source: 'control-api' } });
      if (this.opts.onBriefReady) await this.opts.onBriefReady();
      return { ok: true };
    });

    // SSE stream of core events.
    fastify.get('/exec/events', (_req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const listener = (e: CoreEvent): void => {
        reply.raw.write(formatSse(e));
      };
      core.onEvent(listener);
      reply.raw.on('close', () => core.offEvent(listener));
    });
  }
}
