/**
 * preload.js — runs in the renderer process with Node access.
 * Exposes a safe bridge (window.__electronBridge) to:
 *   • The main-world bootstrap below (downloads, print, navigator.share)
 *   • The offline.html / error.html retry buttons
 *
 * Also injects a slim top-of-page progress bar that fires on every
 * navigation so the user always has instant visual feedback, and a focus
 * watchdog that unsticks input fields that stop reacting to clicks.
 */

'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ── Main-world bootstrap ─────────────────────────────────────────────────────
// Runs in the page's own JavaScript world *before* any of the site's scripts
// (preload executes at document start), so feature checks such as
// `if (navigator.share)` or blobs created by early scripts all see our patches.
const MAIN_WORLD_BOOTSTRAP = `
(function() {
  if (window.__inkeepxElectronPatched) return;
  window.__inkeepxElectronPatched = true;

  function bridge() { return window.__electronBridge || null; }

  // ── Print bridge ──────────────────────────────────────────────────────────
  window.__electronPrint = function() { if (bridge()) bridge().printPage(); };
  window.print = function() { window.__electronPrint(); };

  // ── navigator.share / canShare polyfill ───────────────────────────────────
  // Chrome on Windows implements the Web Share API; Electron does not, so the
  // site's share buttons (WhatsApp, Email…) never render. We forward the call
  // to the main process which offers WhatsApp / Email / Copy / Save.
  function fileToTransfer(f) {
    return new Promise(function(resolve) {
      try {
        var fr = new FileReader();
        fr.onloadend = function() {
          var d = String(fr.result || '');
          var i = d.indexOf(',');
          resolve({ name: f.name || 'file', type: f.type || 'application/octet-stream',
                    b64: i >= 0 ? d.substring(i + 1) : '' });
        };
        fr.onerror = function() { resolve(null); };
        fr.readAsDataURL(f);
      } catch (e) { resolve(null); }
    });
  }
  function hasShareData(d) {
    return !!(d && (d.title || d.text || d.url || (d.files && d.files.length)));
  }
  function share(d) {
    if (!hasShareData(d)) return Promise.reject(new TypeError('No known share data fields supplied'));
    if (!bridge()) return Promise.reject(new DOMException('Share not available', 'NotAllowedError'));
    var files = Array.prototype.slice.call((d && d.files) || []);
    return Promise.all(files.map(fileToTransfer)).then(function(list) {
      return bridge().share({
        title: d.title ? String(d.title) : '',
        text:  d.text  ? String(d.text)  : '',
        url:   d.url   ? String(d.url)   : '',
        files: list.filter(Boolean),
      });
    }).then(function(r) {
      if (r && r.ok) return;
      throw new DOMException((r && r.message) || 'Share canceled', (r && r.error) || 'AbortError');
    });
  }
  try {
    Object.defineProperty(Navigator.prototype, 'share',    { configurable: true, writable: true, value: share });
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, writable: true, value: hasShareData });
  } catch (e) {}

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
      if (bridge()) bridge().downloadBase64(b64, blob.type || 'application/octet-stream', filename || '');
    };
    fr.readAsDataURL(blob);
  }

  function handleHref(href, filename) {
    if (!href) return false;
    var u = toAbsUrl(href);

    if (u.indexOf('blob:') === 0 && map[u]) {
      if (map[u].b64) {
        if (bridge()) bridge().downloadBase64(map[u].b64, map[u].mime || 'application/octet-stream', filename || '');
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
      if (bridge()) bridge().downloadBase64(b64, mime, filename || '');
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

// Only patch the live site — the local splash/offline/error pages don't need it.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  webFrame.executeJavaScript(MAIN_WORLD_BOOTSTRAP).catch(() => {});
}

// ── Focus watchdog ───────────────────────────────────────────────────────────
// After some navigations Chromium leaves the document without focus even though
// the window has it: clicking a field does nothing. Detect "clicked a field but
// it didn't become active" and ask the main process to un-stick the window.
const FOCUSABLE_SEL = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
let _lastFocusKick = 0;

document.addEventListener('pointerdown', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest(FOCUSABLE_SEL) : null;
  if (!el || el.disabled) return;
  setTimeout(() => {
    if (ev.defaultPrevented) return;                 // custom widget handled it
    const stuck = !document.hasFocus() ||
                  (document.activeElement !== el && document.activeElement === document.body);
    if (!stuck) return;
    const now = Date.now();
    if (now - _lastFocusKick < 1500) return;
    _lastFocusKick = now;
    ipcRenderer.send('focus-fix');
    setTimeout(() => { try { el.focus(); } catch { /* detached */ } }, 80);
  }, 80);
}, true);

// ── In-page top progress bar ──────────────────────────────────────────────────
const STYLE_ID = '__ixProgressStyle';
const BAR_ID   = '__ixProgressBar';

function injectProgressBar() {
  if (!document.body || document.getElementById(BAR_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BAR_ID} {
      position: fixed;
      top: 0; left: 0;
      width: 0%;
      height: 3px;
      background: #E8000D;
      z-index: 2147483647;
      border-radius: 0 2px 2px 0;
      pointer-events: none;
      transition: width 0.2s ease, opacity 0.3s ease;
      opacity: 0;
      box-shadow: 0 0 8px rgba(232,0,13,0.6);
    }
    #${BAR_ID}.running  { opacity: 1; }
    #${BAR_ID}.finishing {
      width: 100% !important;
      opacity: 0;
      transition: width 0.25s ease, opacity 0.4s ease 0.1s;
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  document.body.appendChild(bar);
}

let _barTimer    = null;
let _barProgress = 0;

function barStart() {
  let bar = document.getElementById(BAR_ID);
  if (!bar) { injectProgressBar(); bar = document.getElementById(BAR_ID); }
  if (!bar) return;

  clearInterval(_barTimer);
  bar.classList.remove('finishing');
  _barProgress = 0;
  bar.style.width = '0%';

  requestAnimationFrame(() => {
    bar.classList.add('running');
    bar.style.width = '15%';
    _barProgress = 15;

    _barTimer = setInterval(() => {
      if (_barProgress >= 85) { clearInterval(_barTimer); return; }
      const step = _barProgress < 50 ? 8 : _barProgress < 70 ? 4 : 1.5;
      _barProgress = Math.min(_barProgress + step, 85);
      bar.style.width = _barProgress + '%';
    }, 250);
  });
}

function barDone() {
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;
  clearInterval(_barTimer);
  bar.classList.add('finishing');
  setTimeout(() => {
    bar.classList.remove('running', 'finishing');
    bar.style.width = '0%';
    _barProgress = 0;
  }, 600);
}

// ── Find-in-page bar (Ctrl+F) ─────────────────────────────────────────────────
const FIND_ID = '__ixFindBar';

function injectFindBar() {
  let bar = document.getElementById(FIND_ID);
  if (bar) return bar;

  const style = document.createElement('style');
  style.textContent = `
    #${FIND_ID} {
      position: fixed;
      top: 10px; right: 16px;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: #ffffff;
      border: 1px solid #dddddd;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #${FIND_ID}.open { display: flex; }
    #${FIND_ID} input {
      width: 180px;
      border: none;
      outline: none;
      font-size: 13px;
      color: #111;
      background: transparent;
    }
    #${FIND_ID} .__ixCount {
      font-size: 12px;
      color: #888;
      min-width: 40px;
      text-align: center;
      user-select: none;
    }
    #${FIND_ID} button {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      color: #555;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
    }
    #${FIND_ID} button:hover { background: #f0f0f0; }
  `;
  document.head.appendChild(style);

  bar = document.createElement('div');
  bar.id = FIND_ID;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Find on page';

  const count = document.createElement('span');
  count.className = '__ixCount';
  count.textContent = '';

  const mkBtn = (txt, title, onClick) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  const doFind = (findNext, forward) => {
    const text = input.value;
    if (!text) return;
    ipcRenderer.send('find-in-page', text, { findNext, forward });
  };

  const closeBar = () => {
    bar.classList.remove('open');
    count.textContent = '';
    ipcRenderer.send('find-stop');
    // Hand focus back to the page so typing works right away
    try { input.blur(); } catch { /* ignore */ }
  };

  input.addEventListener('input', () => {
    if (input.value) {
      ipcRenderer.send('find-in-page', input.value, { findNext: false });
    } else {
      count.textContent = '';
      ipcRenderer.send('find-stop');
    }
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); doFind(true, !ev.shiftKey); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeBar(); }
  });

  bar.appendChild(input);
  bar.appendChild(count);
  bar.appendChild(mkBtn('‹', 'Previous match (Shift+Enter)', () => doFind(true, false)));
  bar.appendChild(mkBtn('›', 'Next match (Enter)',           () => doFind(true, true)));
  bar.appendChild(mkBtn('✕', 'Close (Esc)',                  closeBar));
  document.body.appendChild(bar);

  bar.__ixInput = input;
  bar.__ixCount = count;
  return bar;
}

ipcRenderer.on('find-open', () => {
  if (!document.body) return;
  const bar = injectFindBar();
  bar.classList.add('open');
  bar.__ixInput.focus();
  bar.__ixInput.select();
});

ipcRenderer.on('find-result', (e, { activeMatchOrdinal, matches }) => {
  const bar = document.getElementById(FIND_ID);
  if (bar && bar.__ixCount && bar.classList.contains('open')) {
    bar.__ixCount.textContent = matches > 0 ? `${activeMatchOrdinal}/${matches}` : '0/0';
  }
});

// ── Listen for main-process signals ──────────────────────────────────────────
ipcRenderer.on('page-loading-start', () => {
  if (document.body) { barStart(); }
  else {
    const t = setInterval(() => { if (document.body) { clearInterval(t); injectProgressBar(); barStart(); } }, 30);
  }
});

ipcRenderer.on('page-loading-done', barDone);

// Inject bar as soon as DOM is ready
document.addEventListener('DOMContentLoaded', injectProgressBar, { once: true });
if (document.body) injectProgressBar();

// ── Exposed API ───────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('__electronBridge', {
  downloadBase64: (base64, mimeType, suggestedName) =>
    ipcRenderer.send('download-base64', { base64, mimeType, suggestedName }),

  openFileDialog: (opts) => ipcRenderer.invoke('open-file-dialog', opts),

  // navigator.share() polyfill → WhatsApp / Email / Copy / Save chooser in main
  share:      (data) => ipcRenderer.invoke('share', data),

  printPage:  () => ipcRenderer.send('print-page'),
  goBack:     () => ipcRenderer.send('nav-back'),
  goForward:  () => ipcRenderer.send('nav-forward'),
  reload:     () => ipcRenderer.send('nav-reload'),
  goHome:     () => ipcRenderer.send('nav-home'),
  retry:      () => ipcRenderer.send('retry'),
  navState:   () => ipcRenderer.invoke('nav-state'),
});
