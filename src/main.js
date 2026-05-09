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
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');
const url   = require('url');

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

// ── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── createWindow ─────────────────────────────────────────────────────────────
function createWindow() {
  const ses = session.fromPartition(`persist:${SESS_PART}`);

  // Cookies persist automatically with a named partition.
  // Allow third-party cookies (same as Android's setAcceptThirdPartyCookies).
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // Allow all permissions the site may request (camera, microphone, etc.)
    callback(true);
  });

  mainWin = new BrowserWindow({
    width:  1280,
    height: 820,
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
  });

  // Open external links in the system browser
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (!openUrl.includes('inkeepx.com')) {
      shell.openExternal(openUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  wc.on('will-navigate', (event, navUrl) => {
    // Allow local pages (loading / offline)
    if (navUrl.startsWith('file://')) return;
    // Keep navigation inside inkeepx.com; send everything else to the browser
    if (!navUrl.includes('inkeepx.com') && !navUrl.startsWith('about:')) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
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
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function setupIpc(ses) {
  // Navigation controls from the UI overlay
  ipcMain.on('nav-back',    () => mainWin?.webContents.goBack());
  ipcMain.on('nav-forward', () => mainWin?.webContents.goForward());
  ipcMain.on('nav-reload',  () => mainWin?.webContents.reload());
  ipcMain.on('nav-home',    () => mainWin?.loadURL(LOGIN_URL));

  // Retry when offline — load the splash then the real URL
  ipcMain.on('retry', () => {
    if (!mainWin) return;
    isOffline  = false;
    const prefs = readPrefs();
    pendingUrl  = prefs.lastUrl || LOGIN_URL;
    mainWin.loadURL(LOADING_PAGE);
  });

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
  // Let Electron show the native save-as dialog
  const defaultPath = path.join(
    app.getPath('downloads'),
    item.getFilename()
  );

  // Show native save dialog
  const savePath = dialog.showSaveDialogSync(mainWin, {
    title:       'Save File',
    defaultPath,
    buttonLabel: 'Save',
  });

  if (!savePath) {
    item.cancel();
    return;
  }

  item.setSavePath(savePath);

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

  const savePath = dialog.showSaveDialogSync(mainWin, {
    title:       'Save File',
    defaultPath: path.join(app.getPath('downloads'), name),
    buttonLabel: 'Save',
  });

  if (!savePath) return;  // user cancelled

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
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
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
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
