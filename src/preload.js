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
