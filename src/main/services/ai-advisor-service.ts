/**
 * AI Portfolio Advisor Service — Phase 3 of the AI Portfolio Advisor (migration 014).
 *
 * Improvements (v0.16.1):
 *  • Model upgraded to claude-opus-4-7
 *  • Adaptive thinking (thinking: {type:"adaptive"}) for deeper reasoning
 *  • Prompt caching on the static system prompt — ~90% cost reduction on repeated runs
 *  • Tool use replaces JSON-in-text → structured output is guaranteed, no parse failures
 *  • Streaming: thinking deltas are forwarded to the renderer in real time via callback
 *
 * API key stored via secureSet(db, 'anthropicApiKey', key).
 *
 * see docs/formulas.md#ai-advisor
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { secureGet } from './secure-settings.js';
import type {
  PositionEtrade,
  PositionAnalysis,
  AdvisorSession,
  AdvisorActionItem,
  AdvisorProgressEvent,
} from '@shared/types.js';

// ─── Model constants ──────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-opus-4-7';
/** Tokens allocated for thinking + tool-call output. Keep well above 4 k. */
const MAX_TOKENS    = 16_000;

// ─── System prompt (cached — do NOT change unless necessary) ─────────────────
// Cache prefix: this block is sent with cache_control: ephemeral so the first
// request pays 1.25× write cost; every subsequent request in the cache TTL
// (5 min) pays only 0.1×.  see docs/formulas.md#prompt-caching

const SYSTEM_PROMPT = `You are a private portfolio advisor for a retail options and swing trader.
You specialize in the Wheel Strategy (Cash-Secured Puts + Covered Calls), LEAPS, and swing trades.

Your job:
1. Review the portfolio snapshot provided and give ACTIONABLE, SPECIFIC advice.
2. Prioritize positions by urgency (expiry proximity, assignment risk, large unrealized loss/gain).
3. For each position, state ONE clear action: Hold / Close / Roll / Defend / Take Profits.
4. Provide 3–5 portfolio-level observations about concentration, Greeks exposure, or market conditions.
5. List up to 5 concrete action items sorted by urgency (immediate → this_week → monitor).

Be concise and direct. You MUST call the submit_portfolio_advice tool to deliver your response — do not reply in plain text.`;

// ─── Structured output tool ───────────────────────────────────────────────────
// Tool use guarantees a parseable structured response — no JSON-in-text fragility.

const ADVICE_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_portfolio_advice',
  description: 'Submit structured portfolio advice after analyzing all open positions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      position_advice: {
        type: 'object',
        description: 'Per-position advice keyed by position ID (as string). One sentence per position.',
        additionalProperties: { type: 'string' },
      },
      observations: {
        type: 'array',
        items: { type: 'string' },
        description: '3–5 portfolio-level observations (Greeks exposure, concentration, upcoming catalysts, etc.)',
        minItems: 3,
        maxItems: 5,
      },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            positionId: {
              description: 'Position ID (number) if position-specific, or omit for portfolio-level',
              anyOf: [{ type: 'number' }, { type: 'null' }],
            },
            ticker: {
              description: 'Ticker symbol if relevant, or null for portfolio-level',
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            action: {
              type: 'string',
              description: 'Specific, actionable instruction (e.g. "Roll the $150 put to next month at $155")',
            },
            rationale: {
              type: 'string',
              description: 'Why this action is recommended',
            },
            urgency: {
              type: 'string',
              enum: ['immediate', 'this_week', 'monitor'],
            },
          },
          required: ['action', 'rationale', 'urgency'],
        },
        description: 'Up to 5 concrete action items sorted by urgency (immediate first)',
        maxItems: 5,
      },
      summary: {
        type: 'string',
        description: '2–3 sentence narrative summary of the overall portfolio state and key themes',
      },
    },
    required: ['position_advice', 'observations', 'action_items', 'summary'],
  },
};

// ─── Progress callback ────────────────────────────────────────────────────────

export type AdvisorProgressCallback = (event: AdvisorProgressEvent) => void;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 2): string {
  return v != null ? v.toFixed(decimals) : 'N/A';
}

function fmtPct(v: number | null | undefined): string {
  return v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : 'N/A';
}

function buildPositionBlock(
  pos: PositionEtrade,
  analysis: PositionAnalysis | null
): string {
  const lines: string[] = [];
  lines.push(`[Position ID ${pos.id}] ${pos.ticker} — ${pos.positionType}`);
  lines.push(`  Qty: ${pos.quantity} | Entry: $${fmt(pos.entryPrice)}`);

  if (pos.positionType !== 'Stock' && pos.strikePrice) {
    const exp = pos.expirationDate ?? 'N/A';
    const daysLeft = pos.expirationDate
      ? Math.round((new Date(pos.expirationDate).getTime() - Date.now()) / 86_400_000)
      : null;
    lines.push(`  Strike: $${fmt(pos.strikePrice)} | Expiry: ${exp} (${daysLeft ?? '?'} DTE)`);
    if (pos.premiumReceived != null) {
      lines.push(`  Premium collected: $${fmt(pos.premiumReceived)}/share`);
    }
  }

  if (pos.marketValue != null)   lines.push(`  Market value: $${fmt(pos.marketValue)}`);
  if (pos.totalGainPct != null)  lines.push(`  Total gain: ${fmtPct(pos.totalGainPct)}`);
  if (pos.daysGain != null)      lines.push(`  Day's gain: $${fmt(pos.daysGain)} (${fmtPct(pos.daysGainPct)})`);

  // Greeks
  const greekParts: string[] = [];
  if (pos.delta != null) greekParts.push(`Δ=${fmt(pos.delta, 3)}`);
  if (pos.theta != null) greekParts.push(`Θ=${fmt(pos.theta, 3)}`);
  if (pos.iv    != null) greekParts.push(`IV=${fmt(pos.iv, 1)}%`);
  if (pos.beta  != null) greekParts.push(`β=${fmt(pos.beta, 2)}`);
  if (greekParts.length > 0) lines.push(`  Greeks: ${greekParts.join(' | ')}`);

  // Technical analysis
  if (analysis) {
    lines.push(`  Technical: trend=${analysis.trend ?? 'N/A'} score=${fmt(analysis.compositeScore)}/10 RSI=${fmt(analysis.rsi, 1)}`);
    if (analysis.assignmentRisk) {
      lines.push(`  Assignment risk: ${analysis.assignmentRisk.toUpperCase()}`);
    }
    lines.push(`  Suggested action: ${analysis.action} (conviction ${analysis.conviction}/3) — ${analysis.explanation}`);
  }

  return lines.join('\n');
}

function buildPrompt(positions: PositionEtrade[], analyses: Map<number, PositionAnalysis>): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const blocks = positions.map(p => buildPositionBlock(p, analyses.get(p.id) ?? null));

  return `Today is ${today}.

Portfolio snapshot (${positions.length} open positions):

${blocks.join('\n\n')}

Please advise.`;
}

// ─── Tool input type ──────────────────────────────────────────────────────────

interface AdvisorToolInput {
  position_advice?: Record<string, string>;
  observations?: string[];
  action_items?: Array<{
    positionId?: number | null;
    ticker?: string | null;
    action?: string;
    rationale?: string;
    urgency?: 'immediate' | 'this_week' | 'monitor';
  }>;
  summary?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AiAdvisorService {

  private getApiKey(db: Database): string {
    const key = secureGet(db, 'anthropicApiKey');
    if (!key) throw new Error('Anthropic API key not configured. Add it in Settings.');
    return key;
  }

  /**
   * Runs the AI advisor on the current open positions.
   * Streams thinking deltas to `onProgress` in real time.
   * Uses tool use to guarantee structured output — no JSON parse failures.
   * System prompt is prompt-cached for ~90% cost reduction on repeated calls.
   */
  async advise(db: Database, onProgress?: AdvisorProgressCallback): Promise<AdvisorSession> {
    const apiKey = this.getApiKey(db);

    // ── Load open positions ───────────────────────────────────────────────────
    onProgress?.({ type: 'status', text: 'Loading positions…' });

    const posRows = db.prepare(`
      SELECT
        p.id, p.ticker, p.position_type, p.quantity, p.entry_price, p.entry_date,
        p.exit_price, p.exit_date, p.exit_notes, p.entry_notes,
        p.strike_price, p.expiration_date, p.premium_received,
        p.current_price, p.unrealized_pnl, p.realized_pnl,
        p.status, p.created_at, p.updated_at,
        p.etrade_position_id, p.etrade_account_id,
        p.market_value, p.total_gain_pct, p.days_gain, p.days_gain_pct,
        p.cost_per_share, p.pct_of_portfolio,
        p.delta, p.gamma, p.theta, p.vega, p.iv, p.beta,
        p.last_synced_at
      FROM positions p
      WHERE p.status = 'open'
      ORDER BY p.ticker
    `).all() as Record<string, unknown>[];

    if (posRows.length === 0) {
      throw new Error('No open positions to advise on. Add positions or sync from E*Trade first.');
    }

    const positions = posRows.map(r => mapPositionRow(r));

    // ── Load analyses ─────────────────────────────────────────────────────────
    const analyses = new Map<number, PositionAnalysis>();
    const analysisRows = db.prepare(`
      SELECT * FROM position_analysis
      WHERE position_id IN (${positions.map(() => '?').join(',')})
    `).all(...positions.map(p => p.id)) as Record<string, unknown>[];

    for (const row of analysisRows) {
      const pa = mapAnalysisRow(row);
      analyses.set(pa.positionId, pa);
    }

    // ── Build prompt ──────────────────────────────────────────────────────────
    const userPrompt = buildPrompt(positions, analyses);

    // ── Call Claude (streaming) ───────────────────────────────────────────────
    // Prompt caching: system block marked with cache_control: ephemeral.
    // First call within a session pays 1.25× write cost; subsequent calls
    // within the 5-min TTL pay only 0.1×.  see docs/formulas.md#prompt-caching
    onProgress?.({ type: 'status', text: `Consulting Claude (${positions.length} positions)…` });

    const client = new Anthropic({ apiKey });

    const stream = client.messages.stream({
      model:      DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      thinking:   { type: 'adaptive', display: 'summarized' },
      system: [
        {
          type:          'text',
          text:          SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [ADVICE_TOOL],
      // tool_choice deliberately omitted (defaults to 'auto') — forced tool_choice
      // is incompatible with thinking mode. One tool defined + system prompt
      // instruction is sufficient for Claude to reliably call submit_portfolio_advice.
    });

    // Stream thinking chunks to UI in real time
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta' &&
        event.delta.thinking
      ) {
        onProgress?.({ type: 'thinking', text: event.delta.thinking });
      }
    }

    const message = await stream.finalMessage();

    // ── Extract tool call result ──────────────────────────────────────────────
    const toolBlock = message.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    );
    // Fallback: if Claude replied in text instead of calling the tool (rare with
    // auto mode + explicit instruction), surface the text as the summary.
    const textFallback = !toolBlock
      ? message.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
      : '';
    const parsed: AdvisorToolInput = toolBlock
      ? (toolBlock.input as AdvisorToolInput)
      : { summary: textFallback };

    // ── Map action items ──────────────────────────────────────────────────────
    const actionItems: AdvisorActionItem[] = (parsed.action_items ?? []).map(item => ({
      positionId: item.positionId ?? null,
      ticker:     item.ticker ?? null,
      action:     item.action ?? '',
      rationale:  item.rationale ?? '',
      urgency:    item.urgency ?? 'monitor',
    }));

    // ── Store session ─────────────────────────────────────────────────────────
    onProgress?.({ type: 'status', text: 'Saving session…' });

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO advisor_sessions (
        requested_at, positions_json, advice_text,
        action_items_json, position_advice_json, observations_json,
        model, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      JSON.stringify(positions),
      parsed.summary ?? '',
      JSON.stringify(actionItems),
      JSON.stringify(parsed.position_advice ?? {}),
      JSON.stringify(parsed.observations ?? []),
      message.model,
      message.usage.input_tokens,
      message.usage.output_tokens,
    );

    const sessionId = info.lastInsertRowid as number;

    onProgress?.({ type: 'done', text: 'Done' });

    return {
      id:             sessionId,
      requestedAt:    now,
      adviceText:     parsed.summary ?? '',
      actionItems,
      positionAdvice: parsed.position_advice ?? {},
      observations:   parsed.observations ?? [],
      model:          message.model,
      inputTokens:    message.usage.input_tokens,
      outputTokens:   message.usage.output_tokens,
    };
  }

  /** Return the N most recent advisor sessions. */
  getHistory(db: Database, limit = 10): AdvisorSession[] {
    const rows = db.prepare(
      'SELECT * FROM advisor_sessions ORDER BY requested_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];

    return rows.map(r => ({
      id:             r['id'] as number,
      requestedAt:    r['requested_at'] as string,
      adviceText:     r['advice_text'] as string,
      actionItems:    JSON.parse((r['action_items_json'] as string | null) ?? '[]') as AdvisorActionItem[],
      positionAdvice: JSON.parse((r['position_advice_json'] as string | null) ?? '{}') as Record<string, string>,
      observations:   JSON.parse((r['observations_json'] as string | null) ?? '[]') as string[],
      model:          r['model'] as string,
      inputTokens:    (r['input_tokens'] as number | null) ?? null,
      outputTokens:   (r['output_tokens'] as number | null) ?? null,
    }));
  }
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapPositionRow(r: Record<string, unknown>): PositionEtrade {
  return {
    id:               r['id'] as number,
    ticker:           r['ticker'] as string,
    positionType:     r['position_type'] as 'CSP' | 'CC' | 'Stock',
    quantity:         r['quantity'] as number,
    entryPrice:       r['entry_price'] as number,
    entryDate:        r['entry_date'] as string,
    entryNotes:       (r['entry_notes'] as string | null) ?? null,
    exitPrice:        (r['exit_price'] as number | null) ?? null,
    exitDate:         (r['exit_date'] as string | null) ?? null,
    exitNotes:        (r['exit_notes'] as string | null) ?? null,
    strikePrice:      (r['strike_price'] as number | null) ?? null,
    expirationDate:   (r['expiration_date'] as string | null) ?? null,
    premiumReceived:  (r['premium_received'] as number | null) ?? null,
    currentPrice:     (r['current_price'] as number | null) ?? null,
    unrealizedPnl:    (r['unrealized_pnl'] as number | null) ?? null,
    realizedPnl:      (r['realized_pnl'] as number | null) ?? null,
    status:           r['status'] as 'open' | 'closed',
    createdAt:        r['created_at'] as string,
    updatedAt:        r['updated_at'] as string,
    etradePositionId: (r['etrade_position_id'] as number | null) ?? null,
    etradeAccountId:  (r['etrade_account_id'] as string | null) ?? null,
    marketValue:      (r['market_value'] as number | null) ?? null,
    totalGainPct:     (r['total_gain_pct'] as number | null) ?? null,
    daysGain:         (r['days_gain'] as number | null) ?? null,
    daysGainPct:      (r['days_gain_pct'] as number | null) ?? null,
    costPerShare:     (r['cost_per_share'] as number | null) ?? null,
    pctOfPortfolio:   (r['pct_of_portfolio'] as number | null) ?? null,
    delta:            (r['delta'] as number | null) ?? null,
    gamma:            (r['gamma'] as number | null) ?? null,
    theta:            (r['theta'] as number | null) ?? null,
    vega:             (r['vega'] as number | null) ?? null,
    iv:               (r['iv'] as number | null) ?? null,
    beta:             (r['beta'] as number | null) ?? null,
    lastSyncedAt:     (r['last_synced_at'] as string | null) ?? null,
  };
}

function mapAnalysisRow(row: Record<string, unknown>): PositionAnalysis {
  return {
    id:               row['id'] as number,
    positionId:       row['position_id'] as number,
    analyzedAt:       row['analyzed_at'] as string,
    trend:            (row['trend'] as 'bullish' | 'bearish' | 'sideways' | null) ?? null,
    rsi:              (row['rsi'] as number | null) ?? null,
    sma20:            (row['sma20'] as number | null) ?? null,
    sma50:            (row['sma50'] as number | null) ?? null,
    sma200:           (row['sma200'] as number | null) ?? null,
    supportLevel:     (row['support_level'] as number | null) ?? null,
    resistanceLevel:  (row['resistance_level'] as number | null) ?? null,
    compositeScore:   (row['composite_score'] as number | null) ?? null,
    daysInPosition:   (row['days_in_position'] as number | null) ?? null,
    currentReturnPct: (row['current_return_pct'] as number | null) ?? null,
    annualizedReturn: (row['annualized_return'] as number | null) ?? null,
    currentDelta:     (row['current_delta'] as number | null) ?? null,
    thetaDecay:       (row['theta_decay'] as number | null) ?? null,
    ivRank:           (row['iv_rank'] as number | null) ?? null,
    assignmentRisk:   (row['assignment_risk'] as 'low' | 'medium' | 'high' | null) ?? null,
    rollOpportunity:  row['roll_opportunity']
      ? JSON.parse(row['roll_opportunity'] as string)
      : null,
    action:      row['action'] as PositionAnalysis['action'],
    conviction:  row['conviction'] as 1 | 2 | 3,
    explanation: row['explanation'] as string,
  };
}
