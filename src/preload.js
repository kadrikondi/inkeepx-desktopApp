/**
 * preload.js — runs in the renderer process with Node access.
 * Exposes a safe bridge (window.__electronBridge) to:
 *   • The injected download-compat scripts on the live web page
 *   • The offline.html retry button
 *
 * Also injects a slim top-of-page progress bar that fires on every
 * navigation so the user always has instant visual feedback.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── In-page top progress bar ──────────────────────────────────────────────────
const STYLE_ID = '__ixProgressStyle';
const BAR_ID   = '__ixProgressBar';

function injectProgressBar() {
  if (document.getElementById(BAR_ID)) return;

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

  printPage:  () => ipcRenderer.send('print-page'),
  goBack:     () => ipcRenderer.send('nav-back'),
  goForward:  () => ipcRenderer.send('nav-forward'),
  reload:     () => ipcRenderer.send('nav-reload'),
  goHome:     () => ipcRenderer.send('nav-home'),
  retry:      () => ipcRenderer.send('retry'),
  navState:   () => ipcRenderer.invoke('nav-state'),
});
