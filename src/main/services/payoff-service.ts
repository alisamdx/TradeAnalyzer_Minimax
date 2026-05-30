/**
 * PayoffService — CRUD for saved multi-leg payoff strategies + AI assessment.
 * see docs/formulas.md#payoff-visualizer
 */

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type {
  PayoffLeg,
  SavedPayoffStrategy,
  PayoffAssessInput,
  PayoffAssessment,
} from '@shared/types.js';

// ─── Assessment tool schema ────────────────────────────────────────────────────

const ASSESS_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_trade_assessment',
  description: 'Submit a structured expert assessment of an options strategy.',
  input_schema: {
    type: 'object' as const,
    properties: {
      strategyName: {
        type: 'string',
        description: 'Recognised strategy name (e.g. Cash-Secured Put, Iron Condor, Collar).',
      },
      rating: {
        type: 'string',
        enum: ['excellent', 'good', 'neutral', 'caution', 'avoid'],
        description: 'Overall rating for this trade setup.',
      },
      ratingReason: {
        type: 'string',
        description: 'One-sentence justification for the rating.',
      },
      pros: {
        type: 'array', items: { type: 'string' },
        description: '2–4 key advantages of this specific trade.',
      },
      cons: {
        type: 'array', items: { type: 'string' },
        description: '2–4 key risks or disadvantages.',
      },
      idealMarket: {
        type: 'string',
        description: 'The market condition (direction + volatility) where this strategy profits most.',
      },
      keyRisks: {
        type: 'array', items: { type: 'string' },
        description: '2–3 specific risk factors for this exact setup (strikes, premium, expiry).',
      },
      probOfProfit: {
        type: 'string',
        description: 'Estimated probability of profit — e.g. "~68% based on Δ 0.32". Use empty string if insufficient data.',
      },
      exit: {
        type: 'object',
        description: 'Exit strategy for three market scenarios.',
        properties: {
          closeAll: {
            type: 'object',
            properties: {
              trigger: { type: 'string', description: 'Price level or condition that should prompt closing the whole position.' },
              details: { type: 'string', description: 'Reasoning and expected outcome when closing.' },
            },
            required: ['trigger', 'details'],
          },
          bullish: {
            type: 'object',
            properties: {
              trigger: { type: 'string', description: 'Bullish price action or signal that triggers action.' },
              exitFirst: { type: 'string', description: 'Which leg to close first — and exactly why.' },
              holdLast:  { type: 'string', description: 'Which leg to keep open — and why it still has value.' },
            },
            required: ['trigger', 'exitFirst', 'holdLast'],
          },
          bearish: {
            type: 'object',
            properties: {
              trigger: { type: 'string', description: 'Bearish price action or signal that triggers action.' },
              exitFirst: { type: 'string', description: 'Which leg to close first — and exactly why.' },
              holdLast:  { type: 'string', description: 'Which leg to keep open — and why it still has value.' },
            },
            required: ['trigger', 'exitFirst', 'holdLast'],
          },
        },
        required: ['closeAll', 'bullish', 'bearish'],
      },
    },
    required: ['strategyName', 'rating', 'ratingReason', 'pros', 'cons',
               'idealMarket', 'keyRisks', 'probOfProfit', 'exit'],
  },
};

const ASSESS_SYSTEM = `You are an expert options trader and strategy analyst for retail traders. \
You specialise in wheel strategies, covered calls, cash-secured puts, collars, and defined-risk spreads.

When assessing a strategy consider:
- Risk/reward ratio relative to the stock's probable price behaviour
- Probability of profit derived from delta when available
- How time decay, volatility exposure, and directional risk interact for this exact setup
- Practical, actionable exit rules that a retail trader can actually execute

You MUST call the submit_trade_assessment tool with your complete, structured analysis.`;

// ─── PayoffService ─────────────────────────────────────────────────────────────

export class PayoffService {
  // ── CRUD ──────────────────────────────────────────────────────────────────────

  save(db: Database, name: string, ticker: string | null, legs: PayoffLeg[]): SavedPayoffStrategy {
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO payoff_strategies (name, ticker, legs_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), ticker ?? null, JSON.stringify(legs), now);

    return {
      id:        info.lastInsertRowid as number,
      name:      name.trim(),
      ticker:    ticker ?? null,
      legs,
      createdAt: now,
    };
  }

  list(db: Database): SavedPayoffStrategy[] {
    const rows = db.prepare(
      'SELECT * FROM payoff_strategies ORDER BY created_at DESC'
    ).all() as Record<string, unknown>[];

    return rows.map(r => ({
      id:        r['id'] as number,
      name:      r['name'] as string,
      ticker:    (r['ticker'] as string | null) ?? null,
      legs:      JSON.parse((r['legs_json'] as string | null) ?? '[]') as PayoffLeg[],
      createdAt: r['created_at'] as string,
    }));
  }

  delete(db: Database, id: number): void {
    db.prepare('DELETE FROM payoff_strategies WHERE id = ?').run(id);
  }

  // ── AI assessment ──────────────────────────────────────────────────────────────

  async assess(
    legs: PayoffLeg[],
    input: PayoffAssessInput,
    apiKey: string,
    onProgress?: (thinkingChunk: string) => void,
  ): Promise<PayoffAssessment> {
    const client = new Anthropic({ apiKey });

    // ── Build descriptive message ───────────────────────────────────────────────
    const legsText = legs.map((leg, i) => {
      const parts: string[] = [
        `Leg ${i + 1}: ${leg.side.toUpperCase()} ${leg.type.toUpperCase()}`,
      ];
      if (leg.type !== 'stock') {
        parts.push(`strike $${leg.strike}`, `expiry ${leg.expiry}`, `premium $${leg.premium.toFixed(2)}`);
      } else {
        parts.push(`entry $${leg.premium.toFixed(2)}`);
      }
      parts.push(`qty ${leg.quantity}`);
      if (leg.delta != null)  parts.push(`Δ ${leg.delta}`);
      if (leg.iv    != null)  parts.push(`IV ${leg.iv.toFixed(1)}%`);
      return parts.join(', ');
    }).join('\n');

    const fmtMoney = (v: number | null, unlimited: boolean) =>
      unlimited ? 'Unlimited' : (v == null ? 'Unknown' : `$${v.toFixed(2)}`);

    const metricsText = [
      `Spot: $${input.spot}`,
      `Max Profit: ${fmtMoney(input.maxProfit, input.unlimitedProfit)}`,
      `Max Loss:   ${fmtMoney(input.maxLoss,   input.unlimitedLoss)}`,
      `Breakevens: ${input.breakevenPrices.length === 0 ? 'None' : input.breakevenPrices.map(p => `$${p.toFixed(2)}`).join(', ')}`,
      `Net Premium: ${input.netPremium >= 0 ? `$${input.netPremium.toFixed(2)} credit` : `$${Math.abs(input.netPremium).toFixed(2)} debit`}`,
      input.netDelta != null ? `Net Δ: ${input.netDelta.toFixed(2)}`                    : null,
      input.netTheta != null ? `Net Θ: $${input.netTheta.toFixed(2)}/day`               : null,
      input.netVega  != null ? `Net V: $${input.netVega.toFixed(2)} per 1% IV`          : null,
    ].filter(Boolean).join('\n');

    const userMessage =
      `Analyse this options strategy${input.ticker ? ` on ${input.ticker}` : ''}:\n\n` +
      `Strategy: ${input.strategyName}\n\n` +
      `Legs:\n${legsText}\n\n` +
      `At-expiration metrics:\n${metricsText}\n\n` +
      `Please call submit_trade_assessment with your full expert analysis including specific exit guidance.`;

    // Signal the UI immediately so the button feedback is visible
    onProgress?.('Connecting to Claude…');

    // ── Streaming call — forwards thinking summaries + text chunks to the UI ───
    let message: Anthropic.Messages.Message;
    try {
      const stream = client.messages.stream({
        model:      'claude-opus-4-7',
        max_tokens: 8_192,
        thinking:   { type: 'adaptive', display: 'summarized' },
        system: [{
          type: 'text',
          text: ASSESS_SYSTEM,
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: userMessage }],
        tools:    [ASSESS_TOOL],
      });

      // Forward model preamble text (if any) so the UI isn't frozen
      stream.on('text', (text) => onProgress?.(text));

      // Forward thinking summaries — keeps the UI alive during the reasoning phase
      stream.on('streamEvent', (event) => {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'thinking_delta'
        ) {
          onProgress?.(event.delta.thinking);
        }
      });

      message = await stream.finalMessage();
    } catch (apiErr) {
      console.error('[payoff:assess] Anthropic API error:', apiErr);
      throw apiErr;
    }

    const toolBlock = message.content.find(b => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      // Surface any text Claude returned as the error message
      const textFallback = message.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.Messages.TextBlock).text)
        .join('');
      throw new Error(
        textFallback
          ? `Claude did not call the assessment tool. Response: ${textFallback.slice(0, 300)}`
          : 'Assessment failed — model did not return structured data. Try again.'
      );
    }
    return toolBlock.input as PayoffAssessment;
  }
}
