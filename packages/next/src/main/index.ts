import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { COLLECTOR_VERSION, DICTIONARY_VERSION } from '@tradeanalyzer/core';
import { closeGeneration, closeReadOnlyWindows, openGeneration } from './generation.js';
import { registerIpc } from './ipc.js';
import { attachWindow, captureStartupLink, handleSecondInstance } from './deeplinks.js';
import { setWindowFactory, type WindowOptions } from './window-factory.js';
import { DEEP_LINK_SCHEME } from '../shared/deeplink.js';

/**
 * TradeAnalyzer 2 — main process.
 *
 * The shell: a window, a preload bridge, the userData separation, the
 * generation open, the single-instance lock that carries
 * `tradeanalyzer-next://` links (05 §11.1), and — from B9c — read-only windows
 * onto closed generations (05 §8).
 */

// 06 §3: userData is `trade-analyzer-next`, deliberately NOT the productName
// default ("TradeAnalyzer 2"), so this exe's settings, logs and window state can
// never collide with the existing app's `trade-analyzer/` directory. Both are
// installed and running at the same time all through stage 1.
app.setPath('userData', join(app.getPath('appData'), 'trade-analyzer-next'));

/**
 * The window icon, for development only.
 *
 * A packaged Windows build takes its taskbar and title-bar icon from the
 * executable's own resource, which electron-builder writes from
 * `build/icon.ico` — so setting it here would be redundant there, and the path
 * would not resolve anyway once `out/` is inside `app.asar`. In `dev` there is
 * no executable resource, so without this the window wears the default Electron
 * icon and looks like a different app than the one that gets packaged.
 */
function devWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  const png = join(import.meta.dirname, '../../build/icon.png');
  return existsSync(png) ? png : undefined;
}

/**
 * One window, with the same isolation whatever it shows.
 *
 * A read-only window onto a closed generation (05 §8) is the same renderer over
 * the same bridge — the main process answers it from that generation's file —
 * with a title and a frame colour that say what it is, so the two can never be
 * mistaken for each other on the taskbar. It is not given deep links: those
 * navigate the window the operator works in.
 */
function createWindow(opts: WindowOptions = {}): BrowserWindow {
  const icon = devWindowIcon();
  const readOnly = opts.readOnlyGeneration !== undefined;
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    fullscreen: false,
    autoHideMenuBar: true,
    title: readOnly
      ? `TradeAnalyzer 2 — gen-${String(opts.readOnlyGeneration).padStart(3, '0')} (read-only)`
      : 'TradeAnalyzer 2',
    ...(readOnly ? { backgroundColor: '#1d1212' } : {}),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (!readOnly) attachWindow(window);

  window.on('ready-to-show', () => {
    // Maximized on open, matching the existing app. `maximize()` rather than
    // `fullscreen: true`: fullscreen hides the title bar and the taskbar, which
    // is wrong for a tool meant to sit alongside the other app all day. The
    // 1400x900 above is only the restore-down size.
    window.maximize();
    window.show();
  });

  // External links open in the real browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return window;
}

/**
 * A startup failure must be **seen** and must **exit**.
 *
 * This is the half the first version got wrong, and the way it was wrong is
 * worth keeping written down. `openGeneration()` runs before the window, and the
 * comment below has always claimed that a failure there is "a startup error the
 * operator sees". It was not: the throw landed in an unhandled promise
 * rejection, which Electron reports as a **warning** on a stderr nobody reads.
 *
 * Then the second half. Because `createWindow()` never ran, **no window ever
 * existed** — and `window-all-closed` only fires once a window has been created
 * and closed. So `app.quit()` was never called and the process stayed alive
 * forever: three Electron processes, no window, no error, no exit. Invisible
 * except in Task Manager, where it looks exactly like an app somebody forgot to
 * close — and it blocks the build guard, which is how it was finally noticed.
 *
 * **The general shape: a startup path that neither shows nor exits produces a
 * headless survivor, and the absence of a window is precisely what disables the
 * mechanism that would have shut it down.** An error dialog is not decoration
 * here; it is the only thing standing between a failed launch and a process that
 * outlives its own purpose.
 */
function reportFatalStartup(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[next] fatal startup error: ${message}`);
  try {
    dialog.showErrorBox('TradeAnalyzer 2 could not start', message);
  } catch {
    // A dialog can fail if the failure happened before Electron was ready
    // enough to show one. Exiting still has to happen, so this is swallowed
    // deliberately — never at the cost of the exit below.
  }
  // `exit`, not `quit`: `quit` is cooperative and runs the normal shutdown, and
  // there is no window here for it to close. This path must terminate.
  app.exit(1);
}

/**
 * One instance, because on Windows that is how a link arrives (05 §11.1).
 *
 * A clicked `tradeanalyzer-next://` link starts a SECOND copy of the exe with
 * the URL in its arguments. The lock makes that copy exit immediately and
 * hands its arguments to this one through `second-instance`, which navigates
 * the window that is already open. Without the lock every click would open
 * another full application on the same generation.
 *
 * `exit(0)` rather than `quit()` for the loser, for the reason in
 * `reportFatalStartup`: it has no window, so nothing cooperative would ever
 * finish shutting it down.
 */
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => handleSecondInstance(argv));
  captureStartupLink(process.argv);

  // Registered from the PACKAGED exe only. In dev the registration would have to
  // point at `electron.exe` plus this project's path — and it would overwrite
  // the packaged exe's own registration in the user's registry, so every link
  // in the status email would start opening a dev server instead of the
  // installed app. Dev can still be driven by passing a link as an argument.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  app.whenReady().then(() => {
    console.log(
      `[next] TradeAnalyzer 2 v${app.getVersion()} — core ${COLLECTOR_VERSION}, dictionary ${DICTIONARY_VERSION}`
    );

    // The generation is opened before the window, so a failure here is a startup
    // error the operator sees rather than an empty UI that looks like no data.
    const generation = openGeneration();
    console.log(
      `[next] generation ${generation.generationNo} (${generation.status})` +
        `${generation.createdNow ? ' — created' : ''} at ${generation.dbPath}`
    );

    setWindowFactory(createWindow);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(reportFatalStartup);

  // A rejection anywhere else in the main process gets the same treatment, for the
  // same reason: the danger is not the error, it is surviving it silently.
  process.on('unhandledRejection', reportFatalStartup);
  process.on('uncaughtException', reportFatalStartup);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    closeReadOnlyWindows();
    closeGeneration();
  });
}
