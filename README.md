# InkeepX Desktop

Windows desktop app for [inkeepx.com](https://www.inkeepx.com) — a full-featured Electron WebView wrapper that mirrors the Android app exactly.

## Features

| Feature | Android App | Desktop App |
|---|---|---|
| Persistent login session | ✅ | ✅ |
| Restores last URL after restart | ✅ | ✅ |
| File upload (native picker, multi-select) | ✅ | ✅ |
| Download: blob: / data: URLs | ✅ | ✅ |
| Download: authenticated CSV export | ✅ | ✅ |
| Download: plain file URLs | ✅ | ✅ |
| Save dialog + Show in Folder | — | ✅ |
| Download progress bar | — | ✅ |
| Offline detection + retry page | ✅ | ✅ |
| Print support | ✅ | ✅ |
| External links open in browser | ✅ | ✅ |
| Back / Forward navigation | ✅ | ✅ |
| Keyboard shortcuts | — | ✅ |

---

## Build via GitHub Actions (recommended — no local setup needed)

1. Push this folder to a **new GitHub repository** (public or private).
2. Go to **Actions** tab → the `Build Windows Desktop App` workflow runs automatically.
3. When it finishes, click the run → scroll down to **Artifacts** → download `inkeepx-windows-installer`.
4. Unzip it — you'll find `InkeepX Setup x.x.x.exe`.
5. Double-click to install on your Windows PC.

---

## Build locally on Windows

### Prerequisites

- [Node.js 20+](https://nodejs.org) (includes npm)
- Windows 10 or 11

### Steps

```bat
REM 1. Clone / copy this folder to your PC, then open a terminal inside it:
cd inkeepx-desktop

REM 2. Install dependencies
npm install

REM 3. Run the app directly (no build needed for testing)
npm start

REM 4. When ready, build the Windows installer
npm run build:win
```

The installer will be in the `dist\` folder:  
`dist\InkeepX Setup 1.0.0.exe`

Double-click it to install. It creates a Start Menu shortcut and a Desktop shortcut.

---

## Shipping a new version (auto-update)

The app auto-updates from **GitHub Releases** (`kadrikondi/inkeepx-desktopApp`).
Users getting updates only happens once you **publish a release** — pushing code
alone does nothing for installed apps. When you have a new version to ship:

```powershell
$env:GH_TOKEN = "ghp_your_token"     # token with repo scope, only on your machine
npm version patch                     # 1.0.1 -> 1.0.2 (never reuse or lower a version)
npm run release                       # builds + uploads installer to GitHub Releases
```

Installed apps check on every launch (and every 4 hours), download the update in
the background, and ask the user to restart. The repo must be **public** for
users to download updates. Full guide, caveats, and alternatives: [AUTO_UPDATE.md](AUTO_UPDATE.md).

---

## Run without installing (development / quick test)

```bat
npm install
npm start
```

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Find on page | `Ctrl+F` |
| Reload | `Ctrl+R` |
| Back | `Alt+←` |
| Forward | `Alt+→` |
| Print | `Ctrl+P` |
| Zoom in | `Ctrl+=` |
| Zoom out | `Ctrl+-` |
| Reset zoom | `Ctrl+0` |
| Full screen | `F11` |

---

## Project structure

```
inkeepx-desktop/
├── src/
│   ├── main.js       ← Electron main process (window, downloads, IPC)
│   └── preload.js    ← Secure bridge between web page and Node
├── assets/
│   └── icon.png      ← App icon
├── .github/
│   └── workflows/
│       └── build.yml ← GitHub Actions build
└── package.json
```

---

## How it works

- **Session**: Uses a named Electron session partition (`persist:inkeepx-persist`). Cookies and localStorage survive app restarts — login is remembered.
- **Downloads**: The preload script intercepts `blob:` and `data:` URLs the same way the Android code does (patching `URL.createObjectURL`), then sends the base64 data to the main process which shows a native Save dialog.
- **File upload**: The main process shows a native `dialog.showOpenDialog` when the web page triggers a file input.
- **Offline**: `did-fail-load` fires an IPC event that shows an offline screen with a Retry button.
- **External links**: `will-navigate` and `setWindowOpenHandler` redirect non-inkeepx.com URLs to `shell.openExternal`.
