/**
 * InkeepX Desktop — main process
 * Mirrors every feature from the Android WebView app:
 *   • Persistent login session (cookies + localStorage survive restarts)
 *   • First load always goes to /login; after login the last URL is restored
 *   • File upload (native file picker, multi-select)
 *   • File download: blob:, data:, authenticated CSV, plain URL
 *   • Offline detection + retry page
 *   • Print via window.print()
 *   • External links open in the system browser
 *   • Navigation toolbar (back / forward / reload / home)
 *   • Right-click context menu (reload, back, forward, open DevTools in dev)
 */

'use strict';

const {
  app,
  BrowserWindow,
  BrowserView,
  session,
  ipcMain,
  dialog,
  shell,
  Menu,
  net,
  nativeTheme,
  screen,
  clipboard,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');
const url   = require('url');

// Bigger disk cache (500 MB) so the site's static assets survive between
// launches — must be set before the app is ready.
app.commandLine.appendSwitch('disk-cache-size', String(500 * 1024 * 1024));

// Windows needs an explicit AppUserModelID or web notifications won't display.
app.setAppUserModelId('com.inkeepx.desktop');

// ── Constants ────────────────────────────────────────────────────────────────
const LOGIN_URL    = 'https://www.inkeepx.com/login';
const APP_URL      = 'https://www.inkeepx.com';
const PREFS_FILE   = path.join(app.getPath('userData'), 'session.json');
const SESS_PART    = 'inkeepx-persist';         // named session keeps cookies
const LOADING_PAGE = url.pathToFileURL(path.join(__dirname, 'loading.html')).toString();
const OFFLINE_PAGE = url.pathToFileURL(path.join(__dirname, 'offline.html')).toString();

// ── State ────────────────────────────────────────────────────────────────────
let isOffline   = false;   // true while the offline page is shown
let pendingUrl  = null;    // the real URL we want to load after the splash
let dataSaver   = false;   // block images/media/trackers when true (restored from prefs)
let mainSes     = null;    // the persistent session, kept for probes/warm-up
let isQuitting  = false;   // don't auto-recover a renderer that died because we're exiting

// ── Tiny JSON store (avoids adding electron-store runtime dep for packaging) ─
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch { return {}; }
}
function writePrefs(data) {
  fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2));
}

// ── Global refs ──────────────────────────────────────────────────────────────
let mainWin = null;

// ── URL helper — is this really our site? ────────────────────────────────────
// Hostname check, not substring: "https://evil.com/inkeepx.com" must NOT pass.
function isInkeepxUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname === 'inkeepx.com' || hostname.endsWith('.inkeepx.com');
  } catch { return false; }
}

// ── Window state persistence (size / position / maximized) ──────────────────
function getSavedWindowState() {
  const s = readPrefs().windowState;
  if (!s || typeof s.width !== 'number' || typeof s.height !== 'number') return null;
  // Drop the saved position if it's no longer on a connected display
  // (e.g. an unplugged external monitor).
  if (typeof s.x === 'number' && typeof s.y === 'number') {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x >= a.x - s.width + 100 && s.x <= a.x + a.width - 100 &&
             s.y >= a.y - 20 && s.y <= a.y + a.height - 100;
    });
    if (!onScreen) { delete s.x; delete s.y; }
  }
  return s;
}

function saveWindowState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const bounds = mainWin.getNormalBounds();
    writePrefs({
      ...readPrefs(),
      windowState: { ...bounds, maximized: mainWin.isMaximized() },
    });
  } catch { /* window already gone */ }
}

// ── Slow-network helpers ─────────────────────────────────────────────────────
const STATIC_ASSET_RE = /\.(m?js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)([?#].*)?$/i;
const TRACKER_RE = /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|connect\.facebook\.net|hotjar\.com|segment\.(io|com)|mixpanel\.com|clarity\.ms)/i;

// Perform DNS + TCP + TLS handshakes while the splash screen is showing so the
// real navigation reuses the warm connection (saves 1–3 s on high-latency links).
function warmUpConnection() {
  if (!mainSes) return;
  try {
    const req = net.request({ method: 'HEAD', url: APP_URL, session: mainSes });
    req.on('response', (res) => { res.on('data', () => {}); res.on('error', () => {}); });
    req.on('error', () => {});
    req.end();
  } catch { /* best-effort only */ }
}

function setupNetworkOptimizations(ses) {
  // Serve static assets from the disk cache for a week even if the server
  // sends short-lived cache headers — repeat launches barely touch the network.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.method !== 'GET' || details.statusCode !== 200 ||
        !STATIC_ASSET_RE.test(details.url)) {
      callback({});
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      const lk = k.toLowerCase();
      if (lk !== 'cache-control' && lk !== 'pragma' && lk !== 'expires') headers[k] = v;
    }
    headers['Cache-Control'] = ['public, max-age=604800, stale-while-revalidate=86400'];
    callback({ responseHeaders: headers });
  });

  // Data Saver: drop images, media and tracker requests when enabled.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (dataSaver && !details.url.startsWith('file:')) {
      if (TRACKER_RE.test(details.url) ||
          details.resourceType === 'image' || details.resourceType === 'media') {
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  });
}

// ── Auto-reconnect probe (runs while the offline page is shown) ──────────────
let reconnectTimer  = null;
let probeInFlight   = false;

function startReconnectProbe() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (!isOffline || !mainWin || !mainSes) { stopReconnectProbe(); return; }
    if (probeInFlight) return;
    probeInFlight = true;
    const req  = net.request({ method: 'HEAD', url: APP_URL, session: mainSes });
    const kill = setTimeout(() => { try { req.abort(); } catch {} }, 4000);
    req.on('response', (res) => {
      clearTimeout(kill);
      probeInFlight = false;
      res.on('data', () => {}); res.on('error', () => {});
      // Server reachable again — reload automatically
      if (isOffline) retryLoad();
    });
    req.on('error', () => { clearTimeout(kill); probeInFlight = false; });
    req.on('abort', () => { clearTimeout(kill); probeInFlight = false; });
    req.end();
  }, 5000);
}

function stopReconnectProbe() {
  clearInterval(reconnectTimer);
  reconnectTimer = null;
  probeInFlight  = false;
}

// Shared by the offline page's Retry button and the auto-reconnect probe.
function retryLoad() {
  if (!mainWin) return;
  isOffline = false;
  stopReconnectProbe();
  warmUpConnection();
  const prefs = readPrefs();
  pendingUrl  = prefs.lastUrl || LOGIN_URL;
  mainWin.loadURL(LOADING_PAGE);
}

// ── Single instance — a second launch just focuses the existing window ──────
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
}

// ── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(() => { if (gotSingleInstanceLock) createWindow(); });

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── createWindow ─────────────────────────────────────────────────────────────
function createWindow() {
  const ses = session.fromPartition(`persist:${SESS_PART}`);
  mainSes   = ses;
  dataSaver = readPrefs().dataSaver === true;

  // Warm the connection immediately — handshakes happen behind the splash.
  warmUpConnection();
  setupNetworkOptimizations(ses);

  // Cookies persist automatically with a named partition.
  // Grant only the permissions the site actually needs, and only to inkeepx.com.
  const ALLOWED_PERMISSIONS = new Set([
    'media',                     // camera + microphone
    'notifications',
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = (details && details.requestingUrl) || webContents.getURL();
    callback(isInkeepxUrl(requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });

  const winState = getSavedWindowState();

  mainWin = new BrowserWindow({
    width:  (winState && winState.width)  || 1280,
    height: (winState && winState.height) || 820,
    x: winState ? winState.x : undefined,
    y: winState ? winState.y : undefined,
    minWidth:  800,
    minHeight: 600,
    title: 'InkeepX',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Enable all features needed by the web app
      plugins: true,
      javascript: true,
      // Allow localStorage / IndexedDB
      partition: `persist:${SESS_PART}`,
    },
  });

  if (winState && winState.maximized) mainWin.maximize();

  // Remember size/position for next launch
  mainWin.on('close', saveWindowState);

  // ── Application menu (minimal — just what's useful) ───────────────────────
  buildAppMenu();

  // ── Download handler ──────────────────────────────────────────────────────
  ses.on('will-download', handleWillDownload);

  // ── Navigation events ─────────────────────────────────────────────────────
  const wc = mainWin.webContents;

  // Taskbar + in-page progress bar
  wc.on('did-start-loading', () => {
    const currentUrl = wc.getURL();
    if (!currentUrl.startsWith('file://')) {
      mainWin.setProgressBar(2); // indeterminate on Windows taskbar
      wc.send('page-loading-start');
    }
  });

  wc.on('did-stop-loading', () => {
    mainWin.setProgressBar(-1);
    wc.send('page-loading-done');
  });

  // Also fire on SPA route changes (no full reload, just URL change)
  wc.on('did-navigate-in-page', () => {
    wc.send('page-loading-start');
    setTimeout(() => wc.send('page-loading-done'), 350);
  });

  wc.on('did-finish-load', () => {
    const currentUrl = wc.getURL();
    mainWin.setProgressBar(-1);

    // If this is our local loading splash, now load the real URL
    if (currentUrl === LOADING_PAGE || currentUrl.includes('loading.html')) {
      if (pendingUrl) {
        const target = pendingUrl;
        pendingUrl = null;
        wc.loadURL(target);
      }
      return;
    }

    // If this is the offline page, nothing more to do
    if (currentUrl.includes('offline.html')) return;

    // Real page loaded — persist session state
    isOffline = false;
    stopReconnectProbe();
    const onLogin = currentUrl.includes('/login');
    const prefs   = readPrefs();
    writePrefs({
      ...prefs,
      loggedIn: !onLogin,
      lastUrl:  onLogin ? LOGIN_URL : currentUrl,
    });

    // Inject compatibility scripts
    injectDownloadCompat(wc);
    wc.executeJavaScript(`window.print = function(){ window.__electronPrint(); };`).catch(() => {});

    // Version tag at the bottom of the login screen
    if (onLogin) injectVersionTag(wc);
  });

  wc.on('did-fail-load', (e, code, desc, validatedUrl, isMainFrame) => {
    mainWin.setProgressBar(-1);
    // -3 = ERR_ABORTED (redirect / navigation cancelled) — ignore
    // Only react to main-frame failures
    if (!isMainFrame || code === -3) return;

    // Don't show offline page if we're already on a local page
    const currentUrl = wc.getURL();
    if (currentUrl.startsWith('file://')) return;

    isOffline = true;
    wc.loadURL(OFFLINE_PAGE);
    startReconnectProbe();
  });

  // Open external links in the system browser
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (!isInkeepxUrl(openUrl)) {
      shell.openExternal(openUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  wc.on('will-navigate', (event, navUrl) => {
    // Allow local pages (loading / offline)
    if (navUrl.startsWith('file://') || navUrl.startsWith('about:')) return;
    // Keep navigation inside inkeepx.com; send everything else to the browser
    if (!isInkeepxUrl(navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  // ── Crash recovery — reload instead of leaving a dead white window ────────
  wc.on('render-process-gone', (e, details) => {
    if (isQuitting || details.reason === 'clean-exit') return;
    console.error('Renderer crashed:', details.reason);
    retryLoad();
  });

  wc.on('unresponsive', () => {
    console.warn('Page unresponsive');
  });

  // Forward find-in-page results to the find bar in the renderer
  wc.on('found-in-page', (e, result) => {
    wc.send('find-result', {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  // ── Right-click context menu ───────────────────────────────────────────────
  wc.on('context-menu', (event, params) => {
    const template = [];

    if (params.linkURL) {
      template.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy Link Address',    click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }

    if (params.isEditable) {
      template.push(
        { role: 'cut',       enabled: params.editFlags.canCut },
        { role: 'copy',      enabled: params.editFlags.canCopy },
        { role: 'paste',     enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
        { type: 'separator' },
      );
    } else if (params.selectionText) {
      template.push(
        { role: 'copy' },
        { type: 'separator' },
      );
    }

    template.push(
      { label: 'Back',    enabled: wc.canGoBack(),    click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload',  click: () => wc.reload() },
    );

    if (process.env.NODE_ENV === 'development') {
      template.push(
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) },
      );
    }

    Menu.buildFromTemplate(template).popup({ window: mainWin });
  });

  // ── IPC handlers ──────────────────────────────────────────────────────────
  setupIpc(ses);

  // ── Initial URL — show loading splash, then load the real URL ────────────
  const prefs = readPrefs();
  pendingUrl = LOGIN_URL;
  if (prefs.loggedIn && prefs.lastUrl && !prefs.lastUrl.includes('/login')) {
    pendingUrl = prefs.lastUrl;
  }
  // Show branded loading splash immediately (no blank window)
  mainWin.loadURL(LOADING_PAGE);

  // ── Auto-update (GitHub Releases) ─────────────────────────────────────────
  setupAutoUpdate();
}

// ── Auto-update ──────────────────────────────────────────────────────────────
// Background checks stay silent unless an update is ready; a manual check
// from the Update menu always answers with a dialog.
let manualUpdateCheck = false;

function setupAutoUpdate() {
  autoUpdater.autoDownload          = true;
  autoUpdater.autoInstallOnAppQuit  = true;   // installs silently on quit

  autoUpdater.on('update-available', (info) => {
    if (manualUpdateCheck) {
      dialog.showMessageBox(mainWin, {
        type:    'info',
        title:   'Update Available',
        message: `Version ${info.version} is available.`,
        detail:  'Downloading in the background — you\'ll be asked to restart when it\'s ready.',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWin, {
        type:    'info',
        title:   'No Updates',
        message: `You're on the latest version (v${app.getVersion()}).`,
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    mainWin?.setProgressBar(p.percent / 100);
  });

  autoUpdater.on('update-downloaded', (info) => {
    manualUpdateCheck = false;
    mainWin?.setProgressBar(-1);
    dialog.showMessageBox(mainWin, {
      type:    'info',
      title:   'Update Ready',
      message: `InkeepX ${info.version} has been downloaded.`,
      detail:  'Restart the app to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    mainWin?.setProgressBar(-1);
    console.error('Auto-update error:', err?.message || err);
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWin, {
        type:    'warning',
        title:   'Update Check Failed',
        message: 'Could not check for updates.',
        detail:  'Please check your internet connection and try again.',
      });
    }
  });

  // Silent background checks — only in the installed (packaged) app
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    // Re-check every 4 hours while the app stays open
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }
}

function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWin, {
      type:    'info',
      title:   'Development Mode',
      message: 'Updates only work in the installed app.',
      detail:  'Build and install the app to test auto-update.',
    });
    return;
  }
  manualUpdateCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function setupIpc(ses) {
  // Navigation controls from the UI overlay
  ipcMain.on('nav-back',    () => mainWin?.webContents.goBack());
  ipcMain.on('nav-forward', () => mainWin?.webContents.goForward());
  ipcMain.on('nav-reload',  () => mainWin?.webContents.reload());
  ipcMain.on('nav-home',    () => mainWin?.loadURL(LOGIN_URL));

  // Retry when offline — load the splash then the real URL
  ipcMain.on('retry', retryLoad);

  // File upload — preload asks us for a file path
  ipcMain.handle('open-file-dialog', async (event, opts = {}) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title:       'Select File',
      properties:  opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters:     opts.filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    return result.filePaths;
  });

  // Base64 download received from the JS bridge in preload
  ipcMain.on('download-base64', async (event, { base64, mimeType, suggestedName }) => {
    await saveBase64File(base64, mimeType, suggestedName);
  });

  // Print
  ipcMain.on('print-page', () => {
    mainWin?.webContents.print({
      silent: false,
      printBackground: true,
    }, (success, reason) => {
      if (!success) console.error('Print failed:', reason);
    });
  });

  // Find in page (Ctrl+F overlay in preload)
  ipcMain.on('find-in-page', (e, text, opts) => {
    if (text) mainWin?.webContents.findInPage(text, opts || {});
  });
  ipcMain.on('find-stop', () => {
    mainWin?.webContents.stopFindInPage('clearSelection');
  });

  // Navigation state query (for enabling/disabling buttons)
  ipcMain.handle('nav-state', () => {
    if (!mainWin) return { canGoBack: false, canGoForward: false };
    return {
      canGoBack:    mainWin.webContents.canGoBack(),
      canGoForward: mainWin.webContents.canGoForward(),
    };
  });
}

// ── Download: will-download (handles normal file downloads) ──────────────────
function handleWillDownload(event, item) {
  const defaultPath = path.join(
    app.getPath('downloads'),
    item.getFilename()
  );

  // Pause the download and show the save dialog asynchronously so the
  // main process (and the whole UI) never freezes while it's open.
  item.pause();
  dialog.showSaveDialog(mainWin, {
    title:       'Save File',
    defaultPath,
    buttonLabel: 'Save',
  }).then(({ canceled, filePath }) => {
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
    item.resume();
  }).catch(() => item.cancel());

  item.on('updated', (e, state) => {
    if (state === 'progressing') {
      const received = item.getReceivedBytes();
      const total    = item.getTotalBytes();
      mainWin?.webContents.send('download-progress', {
        filename: item.getFilename(),
        received,
        total,
        percent: total > 0 ? Math.round((received / total) * 100) : -1,
      });
    }
  });

  item.once('done', (e, state) => {
    mainWin?.webContents.send('download-done', {
      filename: item.getFilename(),
      state,
      savePath: item.getSavePath(),
    });
    if (state === 'completed') {
      // Offer to open the file/folder
      dialog.showMessageBox(mainWin, {
        type:    'info',
        title:   'Download Complete',
        message: `${item.getFilename()} saved.`,
        buttons: ['Show in Folder', 'Open File', 'OK'],
        defaultId: 2,
      }).then(({ response }) => {
        if (response === 0) shell.showItemInFolder(item.getSavePath());
        if (response === 1) shell.openPath(item.getSavePath());
      });
    }
  });
}

// ── Save a base64 blob (from blob: / data: intercept in preload) ─────────────
async function saveBase64File(base64, mimeType, suggestedName) {
  if (!base64) {
    dialog.showErrorBox('Download Failed', 'No data received. Please try again.');
    return;
  }

  // Derive extension
  const mimeMap = {
    'text/csv':               'csv',
    'application/csv':        'csv',
    'application/json':       'json',
    'application/pdf':        'pdf',
    'application/zip':        'zip',
    'image/png':              'png',
    'image/jpeg':             'jpg',
    'image/gif':              'gif',
    'application/octet-stream': 'bin',
    'text/plain':             'txt',
  };
  const ext  = mimeMap[mimeType] || mimeType.split('/')[1] || 'bin';
  const name = suggestedName || `inkeepx_export_${Date.now()}.${ext}`;

  const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWin, {
    title:       'Save File',
    defaultPath: path.join(app.getPath('downloads'), name),
    buttonLabel: 'Save',
  });

  if (canceled || !savePath) return;  // user cancelled

  const data = Buffer.from(base64, 'base64');
  fs.writeFileSync(savePath, data);

  const { response } = await dialog.showMessageBox(mainWin, {
    type:    'info',
    title:   'File Saved',
    message: `${path.basename(savePath)} saved successfully.`,
    buttons: ['Show in Folder', 'Open File', 'OK'],
    defaultId: 2,
  });
  if (response === 0) shell.showItemInFolder(savePath);
  if (response === 1) shell.openPath(savePath);
}

// ── Inject download compat script (mirrors Android injectDownloadCompatScript) 
function injectDownloadCompat(wc) {
  // This JS intercepts blob: and data: URLs created on the page and
  // routes them through the IPC bridge so the main process can save them.
  const js = `
(function() {
  if (window.__inkeepxElectronPatched) return;
  window.__inkeepxElectronPatched = true;

  // ── Print bridge ──────────────────────────────────────────────────────────
  window.__electronPrint = function() {
    if (window.__electronBridge) window.__electronBridge.printPage();
  };

  // ── Blob / data: URL map (same logic as Android) ──────────────────────────
  window.__inkeepxBlobMap = window.__inkeepxBlobMap || {};
  var map = window.__inkeepxBlobMap;
  var origCreate = URL.createObjectURL.bind(URL);
  var origRevoke = URL.revokeObjectURL.bind(URL);

  URL.createObjectURL = function(blob) {
    var u = origCreate(blob);
    try {
      map[u] = { blob: blob, b64: '', mime: (blob && blob.type) ? blob.type : 'application/octet-stream' };
      var fr = new FileReader();
      fr.onloadend = function() {
        var d = String(fr.result || '');
        var i = d.indexOf(',');
        if (map[u]) map[u].b64 = i >= 0 ? d.substring(i + 1) : '';
      };
      fr.readAsDataURL(blob);
    } catch(e) {}
    return u;
  };

  URL.revokeObjectURL = function(u) {
    try { delete map[u]; } catch(e) {}
    return origRevoke(u);
  };

  function toAbsUrl(href) {
    try { return new URL(href, location.href).toString(); } catch(e) { return href; }
  }

  function sendBlob(blob, filename) {
    var fr = new FileReader();
    fr.onloadend = function() {
      var d = String(fr.result || '');
      var i = d.indexOf(',');
      var b64 = i >= 0 ? d.substring(i + 1) : '';
      if (window.__electronBridge) {
        window.__electronBridge.downloadBase64(b64, blob.type || 'application/octet-stream', filename || '');
      }
    };
    fr.readAsDataURL(blob);
  }

  function handleHref(href, filename) {
    if (!href) return false;
    var u = toAbsUrl(href);

    if (u.indexOf('blob:') === 0 && map[u]) {
      if (map[u].b64) {
        if (window.__electronBridge)
          window.__electronBridge.downloadBase64(map[u].b64, map[u].mime || 'application/octet-stream', filename || '');
      } else if (map[u].blob) {
        sendBlob(map[u].blob, filename);
      } else { return false; }
      return true;
    }
    if (u.indexOf('data:') === 0) {
      var parts = u.split(',');
      var meta  = parts[0] || '';
      var b64   = parts[1] || '';
      var mime  = (meta.split(';')[0] || '').replace('data:', '') || 'application/octet-stream';
      if (window.__electronBridge)
        window.__electronBridge.downloadBase64(b64, mime, filename || '');
      return true;
    }
    if (u.indexOf('.csv') >= 0 || u.indexOf('format=csv') >= 0) {
      fetch(u, { credentials: 'include' })
        .then(function(r) { return r.blob(); })
        .then(function(b) { sendBlob(b, filename); })
        .catch(function() {});
      return true;
    }
    return false;
  }

  document.addEventListener('click', function(ev) {
    var a = ev.target && ev.target.closest
      ? ev.target.closest('a[download], a[href*=".csv"], a[href*="format=csv"]')
      : null;
    if (!a) return;
    var href     = a.getAttribute('href') || '';
    var filename = a.getAttribute('download') || '';
    if (handleHref(href, filename)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);

  var origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    try {
      var href     = this.getAttribute('href') || this.href || '';
      var filename = this.getAttribute('download') || '';
      var isDownload = this.hasAttribute('download');
      if (isDownload || href.indexOf('blob:') === 0 || href.indexOf('data:') === 0 ||
          href.indexOf('.csv') >= 0 || href.indexOf('format=csv') >= 0) {
        if (handleHref(href, filename)) return;
      }
    } catch(e) {}
    return origAnchorClick.apply(this, arguments);
  };
})();
  `;
  wc.executeJavaScript(js).catch(() => {});
}

// ── Version tag on the login screen ──────────────────────────────────────────
function injectVersionTag(wc) {
  const js = `(function() {
    if (document.getElementById('__ixVersionTag')) return;
    var d = document.createElement('div');
    d.id = '__ixVersionTag';
    d.textContent = 'InkeepX Online Desktop App \\u2022 v${app.getVersion()}';
    d.style.cssText = 'position:fixed;bottom:14px;left:0;right:0;text-align:center;' +
      "font:12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#999;" +
      'z-index:2147483000;pointer-events:none;user-select:none;';
    document.body.appendChild(d);
  })();`;
  wc.executeJavaScript(js).catch(() => {});
}

// ── App menu ─────────────────────────────────────────────────────────────────
function buildAppMenu() {
  const template = [
    {
      label: 'InkeepX',
      submenu: [
        { label: 'Home',   click: () => mainWin?.loadURL(LOGIN_URL) },
        { type:  'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R',  click: () => mainWin?.webContents.reload() },
        { label: 'Back',   accelerator: 'Alt+Left',      click: () => mainWin?.webContents.goBack() },
        { label: 'Forward',accelerator: 'Alt+Right',     click: () => mainWin?.webContents.goForward() },
        { type: 'separator' },
        { label: 'Print',  accelerator: 'CmdOrCtrl+P',  click: () => mainWin?.webContents.print({ printBackground: true }) },
        { type: 'separator' },
        {
          label: 'Data Saver (block images & media)',
          type: 'checkbox',
          checked: dataSaver,
          click: (item) => {
            dataSaver = item.checked;
            writePrefs({ ...readPrefs(), dataSaver });
            mainWin?.webContents.reload();
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Find on Page…',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWin?.webContents.send('find-open'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn',  accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.NODE_ENV === 'development' ? [
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ] : []),
      ],
    },
    {
      label: 'Update',
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdatesManually },
        { type: 'separator' },
        { label: `Current Version: v${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
