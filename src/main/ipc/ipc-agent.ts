// IPC handlers for TraderAgent integration (v0.12.0).
// Provides read-only views into the agent DB + process spawning to run agent phases.

import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { AgentDbService } from '../services/agent-db-service.js';
import type {
  AgentStatus, AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot, AgentConfig
} from '@shared/types.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' : 'UNKNOWN';
  return { ok: false as const, error: { code, message } };
}

export function registerAgentIpc(agentDb: AgentDbService): void {

  // ── DB management ──────────────────────────────────────────────────────────

  ipcMain.handle('agent:open-db', (_e, dbPath: string) => {
    try {
      const opened = agentDb.open(dbPath);
      return ok(opened);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:close-db', () => {
    try {
      agentDb.close();
      return ok(true);
    } catch (err) { return fail(err); }
  });

  // ── Read queries ───────────────────────────────────────────────────────────

  ipcMain.handle('agent:get-status', () => {
    try {
      const status: AgentStatus = agentDb.getStatus();
      return ok(status);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-trades', (_e, statusFilter?: 'open' | 'closed' | 'all') => {
    try {
      const trades: AgentTrade[] = agentDb.getTrades(statusFilter);
      return ok(trades);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:delete-trade', (_e, id: number) => {
    try {
      agentDb.deleteTrade(id);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-lessons', (_e, limit?: number) => {
    try {
      const lessons: AgentLesson[] = agentDb.getLessons(limit);
      return ok(lessons);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-recommendations', () => {
    try {
      const recs: AgentRecommendation[] = agentDb.getRecommendations();
      return ok(recs);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-memory', () => {
    try {
      const mem: AgentMemorySnapshot | null = agentDb.getMemory();
      return ok(mem);
    } catch (err) { return fail(err); }
  });

  // ── Config read / write ────────────────────────────────────────────────────

  ipcMain.handle('agent:read-config', (_e, projectPath: string) => {
    try {
      const envPath = join(projectPath, '.env');
      const env: Record<string, string> = {};
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq < 0) continue;
          const key = trimmed.slice(0, eq).trim();
          const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
          env[key] = val;
        }
      }
      const num = (k: string, d: number) => { const v = env[k]; return v !== undefined ? parseFloat(v) : d; };
      const str = (k: string, d: string) => env[k] ?? d;
      const config: AgentConfig = {
        apiUrl: str('TRADEANALYZER_API_URL', 'http://127.0.0.1:7432'),
        agentDbPath: str('AGENT_DB_PATH', ''),
        cashBalance: num('CASH_BALANCE', 25000),
        maxPositionPct: num('MAX_POSITION_PCT', 0.15),
        maxPositions: num('MAX_POSITIONS', 5),
        maxPositionsPerSector: num('MAX_POSITIONS_PER_SECTOR', 1),
        kellyFraction: num('KELLY_FRACTION', 0.25),
        dteMin: num('DTE_MIN', 30),
        dteMax: num('DTE_MAX', 45),
        deltaMin: num('DELTA_MIN', 0.20),
        deltaMax: num('DELTA_MAX', 0.35),
        minIv: num('MIN_IV', 20),
        minOi: num('MIN_OI', 500),
        maxBidAskPct: num('MAX_BID_ASK_PCT', 0.05),
        minAnnualizedReturn: num('MIN_ANNUALIZED_RETURN', 0.15),
        earningsExclusionDays: num('EARNINGS_EXCLUSION_DAYS', 14),
        screenerUniverse: (str('SCREENER_UNIVERSE', 'sp500') as AgentConfig['screenerUniverse']),
        preferredModes: str('PREFERRED_MODES', 'wheel,options_income,buy'),
        emailList: str('EMAIL_LIST', ''),
        smtpHost: str('SMTP_HOST', ''),
        smtpPort: num('SMTP_PORT', 587),
        smtpUser: str('SMTP_USER', ''),
        smtpPass: str('SMTP_PASS', ''),
        smtpFrom: str('SMTP_FROM', ''),
      };
      return ok(config);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:write-config', (_e, projectPath: string, config: AgentConfig) => {
    try {
      const envPath = join(projectPath, '.env');
      // Preserve TRADEANALYZER_TOKEN from existing file
      let token = '';
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('TRADEANALYZER_TOKEN=')) {
            token = trimmed.slice('TRADEANALYZER_TOKEN='.length).trim();
          }
        }
      }
      const lines = [
        `TRADEANALYZER_API_URL=${config.apiUrl}`,
        token ? `TRADEANALYZER_TOKEN=${token}` : '',
        `AGENT_DB_PATH=${config.agentDbPath}`,
        `CASH_BALANCE=${config.cashBalance}`,
        `MAX_POSITION_PCT=${config.maxPositionPct}`,
        `MAX_POSITIONS=${config.maxPositions}`,
        `MAX_POSITIONS_PER_SECTOR=${config.maxPositionsPerSector}`,
        `KELLY_FRACTION=${config.kellyFraction}`,
        `SCREENER_UNIVERSE=${config.screenerUniverse}`,
        `PREFERRED_MODES=${config.preferredModes}`,
        `DTE_MIN=${config.dteMin}`,
        `DTE_MAX=${config.dteMax}`,
        `DELTA_MIN=${config.deltaMin}`,
        `DELTA_MAX=${config.deltaMax}`,
        `MIN_IV=${config.minIv}`,
        `MIN_OI=${config.minOi}`,
        `MAX_BID_ASK_PCT=${config.maxBidAskPct}`,
        `MIN_ANNUALIZED_RETURN=${config.minAnnualizedReturn}`,
        `EARNINGS_EXCLUSION_DAYS=${config.earningsExclusionDays}`,
        `EMAIL_LIST=${config.emailList}`,
        `SMTP_HOST=${config.smtpHost}`,
        `SMTP_PORT=${config.smtpPort}`,
        `SMTP_USER=${config.smtpUser}`,
        `SMTP_PASS=${config.smtpPass}`,
        `SMTP_FROM=${config.smtpFrom}`,
      ].filter(Boolean);
      writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
      return ok(true);
    } catch (err) { return fail(err); }
  });

  // ── Process spawning ───────────────────────────────────────────────────────

  ipcMain.handle('agent:run-phase', (_e, phase: string, projectPath: string) => {
    try {
      if (!projectPath || !existsSync(projectPath)) {
        return fail(new Error(`Agent project path not found: ${projectPath}`));
      }

      const validPhases = ['scout', 'decide', 'trade', 'monitor', 'learn', 'run'];
      if (!validPhases.includes(phase)) {
        return fail(new Error(`Unknown phase: ${phase}`));
      }

      const npmScript = `agent:${phase}`;

      const child = spawn('npm', ['run', npmScript], {
        cwd: projectPath,
        shell: true,
        env: { ...process.env }
      });

      const pid = child.pid ?? -1;

      const sendLog = (line: string) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:log', { pid, phase, line });
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(line);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(`[stderr] ${line}`);
        }
      });

      child.on('exit', (code) => {
        sendLog(`[exit] phase=${phase} code=${code ?? '?'}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:phase-done', { pid, phase, code });
          }
        }
      });

      child.on('error', (err) => {
        sendLog(`[error] ${err.message}`);
      });

      return ok({ pid, phase });
    } catch (err) { return fail(err); }
  });

  // ── Close trade (delegates to agent CLI) ──────────────────────────────────

  ipcMain.handle('agent:close-trade', (_e, tradeId: number, reason: string, projectPath: string) => {
    try {
      if (!projectPath || !existsSync(projectPath)) {
        return fail(new Error(`Agent project path not found: ${projectPath}`));
      }

      const pkgJson = join(projectPath, 'package.json');
      if (!existsSync(pkgJson)) {
        return fail(new Error('No package.json in agent project path'));
      }

      const child = spawn(
        'npm',
        ['run', 'agent:close-trade', '--', '--id', String(tradeId), '--reason', reason],
        { cwd: projectPath, shell: true, env: { ...process.env } }
      );

      const sendLog = (line: string) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:log', { pid: child.pid ?? -1, phase: 'close-trade', line });
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(line);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(`[stderr] ${line}`);
        }
      });

      child.on('exit', (code) => {
        sendLog(`[exit] close-trade id=${tradeId} code=${code ?? '?'}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:phase-done', { pid: child.pid ?? -1, phase: 'close-trade', code });
          }
        }
      });

      return ok({ pid: child.pid ?? -1, tradeId });
    } catch (err) { return fail(err); }
  });

  // ── Email positions report ─────────────────────────────────────────────────

  ipcMain.handle('agent:send-positions-email', async (_e, projectPath: string) => {
    try {
      // Read config for SMTP + email list
      const envPath = join(projectPath, '.env');
      const env: Record<string, string> = {};
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq < 0) continue;
          env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        }
      }

      const emailList = (env['EMAIL_LIST'] ?? '').split(',').map((e) => e.trim()).filter(Boolean);
      if (emailList.length === 0) return fail(new Error('No email addresses configured. Add them in Config → Email.'));

      const smtpHost = env['SMTP_HOST'] ?? '';
      const smtpPort = parseInt(env['SMTP_PORT'] ?? '587', 10);
      const smtpUser = env['SMTP_USER'] ?? '';
      const smtpPass = env['SMTP_PASS'] ?? '';
      const smtpFrom = env['SMTP_FROM'] || smtpUser;

      if (!smtpHost || !smtpUser || !smtpPass) {
        return fail(new Error('SMTP not configured. Fill in SMTP Host, User, and Password in Config → Email.'));
      }

      // Gather data from DB
      const trades: AgentTrade[] = agentDb.getTrades('all');
      const status: AgentStatus = agentDb.getStatus();
      const openTrades = trades.filter((t) => t.status === 'open');
      const allTrades = trades;

      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const fmtMoney = (n: number | null | undefined) =>
        n == null ? '—' : n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
      const fmtPct = (n: number | null | undefined) =>
        n == null ? '—' : `${(n * 100).toFixed(1)}%`;
      const fmtDate = (s: string | null | undefined) => s ? s.slice(0, 10) : '—';
      const pnlColor = (n: number | null | undefined) => (n ?? 0) >= 0 ? '#27ae60' : '#e74c3c';

      const tradeRows = (list: AgentTrade[]) => list.map((t) => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 10px;font-weight:600">${t.ticker}</td>
          <td style="padding:6px 10px">${t.strategy}</td>
          <td style="padding:6px 10px">$${t.strike}</td>
          <td style="padding:6px 10px">${fmtDate(t.expiration)}</td>
          <td style="padding:6px 10px">${t.dteAtEntry}d</td>
          <td style="padding:6px 10px">$${t.entryPremium.toFixed(2)}</td>
          <td style="padding:6px 10px">$${t.capitalRequired.toLocaleString()}</td>
          <td style="padding:6px 10px;color:${t.status === 'open' ? '#27ae60' : '#666'}">${t.status}</td>
          <td style="padding:6px 10px;color:${pnlColor(t.actualPl)};font-weight:600">${fmtMoney(t.actualPl)}</td>
          <td style="padding:6px 10px;color:#666;font-size:11px">${t.closeReason ?? '—'}</td>
        </tr>`).join('');

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 0; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 24px; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #f5f5f5; border-radius: 6px; padding: 12px 18px; min-width: 120px; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 4px; }
  .stat-value { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; color: #333; border-bottom: 2px solid #3498db; padding-bottom: 6px; margin: 24px 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { background: #f5f5f5; }
  th { padding: 8px 10px; text-align: left; font-size: 11px; color: #666; text-transform: uppercase; }
  tr:hover { background: #fafafa; }
  .footer { margin-top: 32px; font-size: 11px; color: #aaa; }
</style></head>
<body><div class="wrap">
  <h1>🤖 TraderAgent — Paper Position Report</h1>
  <div class="sub">${dateStr}</div>

  <div class="stats">
    <div class="stat"><div class="stat-label">Open Positions</div><div class="stat-value" style="color:#27ae60">${status.openTrades}</div></div>
    <div class="stat"><div class="stat-label">Total Trades</div><div class="stat-value">${status.openTrades + status.closedTrades}</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-value" style="color:${pnlColor(status.totalPl)}">${fmtMoney(status.totalPl)}</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-value">${fmtPct(status.winRate)}</div></div>
    <div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${fmtPct(status.confidence)}</div></div>
  </div>

  ${openTrades.length > 0 ? `
  <h2>Open Positions (${openTrades.length})</h2>
  <table>
    <thead><tr>
      <th>Ticker</th><th>Strategy</th><th>Strike</th><th>Expiration</th>
      <th>DTE</th><th>Premium</th><th>Capital</th><th>Status</th><th>P&amp;L</th><th>Notes</th>
    </tr></thead>
    <tbody>${tradeRows(openTrades)}</tbody>
  </table>` : '<p style="color:#888">No open positions.</p>'}

  ${allTrades.filter(t => t.status !== 'open').length > 0 ? `
  <h2>Closed Trades (${allTrades.filter(t => t.status !== 'open').length})</h2>
  <table>
    <thead><tr>
      <th>Ticker</th><th>Strategy</th><th>Strike</th><th>Expiration</th>
      <th>DTE</th><th>Premium</th><th>Capital</th><th>Status</th><th>P&amp;L</th><th>Reason</th>
    </tr></thead>
    <tbody>${tradeRows(allTrades.filter(t => t.status !== 'open'))}</tbody>
  </table>` : ''}

  <div class="footer">Generated by TradeAnalyzer · ${now.toISOString()}</div>
</div></body></html>`;

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: emailList.join(', '),
        subject: `TraderAgent Paper Positions — ${openTrades.length} open · ${fmtMoney(status.totalPl)} P&L — ${dateStr}`,
        html,
      });

      return ok({ sent: emailList.length });
    } catch (err) { return fail(err); }
  });
}
