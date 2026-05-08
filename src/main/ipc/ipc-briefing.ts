// IPC handlers for Morning Briefing Dashboard
// Exposes market regime, action items, and top setups
// see SPEC: Priority 7 - Morning Briefing Dashboard

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { BriefingService } from '../services/briefing-service.js';
import { HistoricalDataService } from '../services/historical-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';

export function registerBriefingIpc(
  db: Database,
  getApiKey: () => string
): void {
  const historicalService = new HistoricalDataService(db);
  const dataProvider = new PolygonDataProvider(getApiKey);
  const service = new BriefingService(db, historicalService, dataProvider);

  // ─── Market Regime ──────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getMarketRegime', async () => {
    try {
      const regime = await service.getMarketRegime();
      return { success: true, data: regime };
    } catch (err) {
      console.error('[briefing:getMarketRegime] Error:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Action Items ───────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getActionItems', async () => {
    try {
      const items = await service.getActionItems();
      return { success: true, data: items };
    } catch (err) {
      console.error('[briefing:getActionItems] Error:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Top Setups ─────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getTopSetups', async () => {
    try {
      const setups = await service.getTopSetups();
      return { success: true, data: setups };
    } catch (err) {
      console.error('[briefing:getTopSetups] Error:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Full Briefing ────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getFull', async () => {
    try {
      const briefing = await service.getFullBriefing();
      return { success: true, data: briefing };
    } catch (err) {
      console.error('[briefing:getFull] Error:', err);
      return { success: false, error: String(err) };
    }
  });
}
