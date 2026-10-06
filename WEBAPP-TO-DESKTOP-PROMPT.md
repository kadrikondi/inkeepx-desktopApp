# Master Prompt: Convert Any Web App into a Windows Desktop App (Electron)

**How to use this document:** Fill in the 6 values in the CONFIG block below,
then paste the ENTIRE document (CONFIG + prompt) to an AI code agent
(Claude Code, Cursor, etc.). Work through the phases in order — each phase ends
with a **Milestone** you can verify before moving on. By Phase 5 you have an
installable `.exe`; Phase 6 adds auto-update.

---

## CONFIG — the only part you edit

```
APP_NAME       = TendiServe                      (product name, used in UI and installer)
APP_URL        = https://www.tendiserve.com/login (the page the app opens first)
APP_DOMAIN     = tendiserve.com                  (bare domain — used for security checks)
BRAND_COLOR    = #E8000D                         (hex color for spinners, buttons, accents)
TAGLINE        = Modern Inventory & POS Solutions (one line shown on the splash screen)
APP_ID         = com.tendiserve.desktop          (reverse-DNS id for the installer)
```

---

## THE PROMPT (paste everything below to your AI agent)

You are building a production-quality Windows desktop application that wraps
the web application at **APP_URL** using **Electron**. The result must feel
like a native app, not a browser tab: persistent login, native file
upload/download, camera/microphone support, offline handling with
auto-reconnect, friendly error screens, and a branded splash screen.

Use plain JavaScript (no TypeScript, no framework). Target structure:

```
project/
├── src/
│   ├── main.js        (Electron main process — all logic lives here)
│   ├── preload.js     (secure bridge, progress bar, find bar)
│   ├── loading.html   (branded splash with time-based greeting)
│   ├── offline.html   (no-internet screen)
│   └── error.html     (HTTP 404/500 screen)
├── assets/icon.png    (app icon, 512×512 PNG — ask me to provide one)
└── package.json
```

General rules for every phase:
- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` — always.
- The renderer (web page) must never get Node access; everything goes through
  a `contextBridge` API named `__electronBridge` and IPC handlers.
- After each phase, tell me to run `npm start` and list exactly what I should
  see so I can verify the milestone before you continue.
- Use APP_NAME, APP_URL, APP_DOMAIN, BRAND_COLOR, TAGLINE, APP_ID from CONFIG
  everywhere — never hardcode a different product name or URL.

---

### PHASE 1 — Scaffold + core shell

**Tasks:**
1. Create package.json: `main: src/main.js`, scripts `start: electron .`,
   `build:win: electron-builder --win --x64`. Dev deps: `electron`,
   `electron-builder`. Set `version: 1.0.0`.
2. Create `src/main.js`:
   - Persistent named session partition (`persist:app-session`) so cookies and
     localStorage survive restarts — login is remembered.
   - A small JSON prefs store at `app.getPath('userData')/session.json`
     (read/write helper functions; no external dependency).
   - BrowserWindow 1280×820 (min 800×600), `backgroundColor: '#ffffff'`.
   - On first launch load APP_URL. On later launches: if prefs say the user
     was logged in, restore the last visited URL; otherwise APP_URL.
   - Track the last URL on every successful page load; treat any URL
     containing `/login` (or `/sign`) as logged-out state.
   - **Single-instance lock**: second launch focuses the existing window.
   - **Window state memory**: save size/position/maximized on close, restore
     on launch; discard saved position if that display is disconnected.
   - **External links**: any navigation or window.open to a hostname that is
     NOT APP_DOMAIN (or a subdomain of it) opens in the system browser.
     Parse the URL and compare hostnames — never use substring matching
     (`url.includes(...)` is spoofable by `evil.com/APP_DOMAIN`).
   - Application menu: Home, Reload (Ctrl+R), Back (Alt+Left), Forward
     (Alt+Right), Print (Ctrl+P), zoom roles, fullscreen, Quit.
3. Create `src/preload.js` with the `__electronBridge` contextBridge stub and
   a slim top-of-window progress bar (3px, BRAND_COLOR) that animates during
   any page load or SPA route change (drive it from main via
   `did-start-loading` / `did-stop-loading` / `did-navigate-in-page` IPC).

**Milestone 1:** `npm start` opens the app, shows APP_URL, remembers login
after closing and reopening, and external links open in my default browser.

---

### PHASE 2 — Branded splash with time-based greeting

**Tasks:**
1. Create `src/loading.html`: white page, APP_NAME wordmark (last letter or
   accent in BRAND_COLOR), a spinner in BRAND_COLOR, and:
   - A greeting chosen from the user's clock: 5–12 "Good Morning",
     12–17 "Good Afternoon", 17–21 "Good Evening", else "Good Night" —
     rendered as "Good Morning, welcome to APP_NAME".
   - TAGLINE in smaller grey text underneath.
   - Subtle staggered fade-up animations.
   - A hidden hint that fades in after 12 seconds: "Taking longer than
     usual — your connection may be slow…" (so slow networks never look
     like a frozen app).
2. Show this splash INSTANTLY at startup, then load the real URL when the
   splash finishes loading (store the target in a `pendingUrl` variable).
3. While the splash is visible, fire a throwaway HEAD request to APP_URL from
   the main process using the same session — this warms DNS/TCP/TLS so the
   real page load is 1–3s faster on slow connections.

**Milestone 2:** launching the app shows the branded greeting splash with no
blank window, then the site appears.

---

### PHASE 3 — Files, devices, printing

**Tasks:**
1. **File upload:** native file picker must work for `<input type=file>`,
   including multi-select. (Electron handles this natively — just verify.)
2. **Downloads — three paths, all needed:**
   a. Normal downloads: `session.on('will-download')` → PAUSE the item, show
      an ASYNC save dialog (never `showSaveDialogSync` — it freezes the app),
      resume on confirm. Report progress via IPC. On completion show a dialog
      with "Show in Folder / Open File / OK".
   b. Blob and data-URL downloads (SPAs generate files in JS): inject a
      script into every loaded page that patches `URL.createObjectURL` to
      remember blob→base64 mappings, intercepts clicks on `a[download]`,
      `a[href^=blob:]`, `a[href^=data:]` (both real clicks and programmatic
      `anchor.click()`), and ships the base64 through the bridge to main,
      which shows a save dialog and writes the file.
   c. Authenticated CSV/export links (`.csv` or `format=csv` in href):
      intercept the click, `fetch` with `credentials: 'include'`, convert to
      blob, send through the same base64 path.
3. **Permissions:** `setPermissionRequestHandler` granting ONLY
   `media` (camera+mic), `notifications`, `fullscreen`, `clipboard-read`,
   `clipboard-sanitized-write` — and only when the requesting URL's hostname
   is APP_DOMAIN. Deny everything else.
4. **Printing:** patch `window.print` on every page to call the bridge; main
   process prints with `printBackground: true`. Add
   `app.setAppUserModelId(APP_ID)` at startup so Windows notifications work.

**Milestone 3:** I can upload files, download a normal file AND an in-app
generated export, the site can use my camera after a permission prompt, and
Ctrl+P prints.

---

### PHASE 4 — Network resilience (offline, errors, session expiry)

**Tasks:**
1. Create `src/offline.html` (same visual family as the splash): wifi-off
   icon, "No Internet Connection", text "We'll reconnect automatically as
   soon as you're back online.", and a Try Again button wired to the bridge.
2. On main-frame `did-fail-load` (ignore code -3/aborts): show offline.html.
   While it's shown, probe APP_URL from the main process every 5 seconds
   (HEAD request, 4-second abort guard, never stack probes). The moment a
   probe succeeds, automatically reload the last real URL via the splash.
3. Create `src/error.html`: warning icon, message chosen by `?code=` query
   param — 404 → "Page Not Found…", 5xx → "Server Problem… usually
   temporary", else generic — the code in small text, and two buttons:
   Try Again (retries the EXACT failed URL) and Go to Home.
4. On main-frame `did-navigate` with HTTP status ≥ 400:
   - 401/403/407/440 → session expired: clear logged-in prefs, load the
     splash then APP_URL, and after the login page loads inject a dark toast
     "Your session expired — please sign in again." (auto-fade after 6s).
     Never trigger this on the login page itself (no redirect loops).
   - Any other ≥400 → show error.html with the status code.
5. **Crash recovery:** on `render-process-gone` (unless quitting or
   clean-exit) auto-reload through the splash. No dead white windows, ever.
6. **Slow-network optimizations:**
   - `app.commandLine.appendSwitch('disk-cache-size', <500MB>)` before ready.
   - `onHeadersReceived`: for GET 200 responses to static assets
     (js/css/fonts/images), rewrite Cache-Control to
     `public, max-age=604800, stale-while-revalidate=86400` so repeat
     launches load the app shell from disk.
   - **Data Saver** menu toggle (persisted in prefs): when on, cancel all
     `image`/`media` requests and known analytics/tracker domains via
     `onBeforeRequest`. Reload on toggle.

**Milestone 4:** cutting my Wi-Fi shows the branded offline page and
restoring it auto-reloads without clicking; a 404 URL shows the friendly
error page; killing the renderer process from Task Manager auto-recovers.

---

### PHASE 5 — Desktop polish + build the installer

**Tasks:**
1. **Right-click context menu:** spelling suggestions (top 5) with
   "Add to Dictionary" when a word is misspelled (enable `spellcheck: true`
   + `setSpellCheckerLanguages(['en-US'])`), cut/copy/paste/select-all in
   editable fields, copy for selections, Open Link in Browser / Copy Link
   Address on links, then Back/Forward/Reload always.
2. **Find in page:** Ctrl+F (menu item + accelerator) opens a small overlay
   bar injected by preload — input, match counter ("3/17"), prev/next
   buttons, Enter/Shift+Enter navigation, Esc closes. Wire through
   `webContents.findInPage` / `found-in-page`.
3. **Version tag:** on the login page only, inject small grey fixed text at
   the bottom: "APP_NAME Desktop App • v<version from package.json>".
4. (Optional — POS/receipt apps) **Printer menu:** list installed printers
   via `getPrintersAsync` (mark the Windows default), radio-select a receipt
   printer saved in prefs, a "Silent Receipt Printing" toggle that is
   DISABLED until a printer is chosen. Silent path verifies the printer
   still exists before printing and falls back to the normal dialog on any
   failure. Never silent-print to "whatever the default is".
5. **electron-builder config** in package.json `"build"`: APP_ID, APP_NAME
   as productName, NSIS target x64, `assets/icon.png` as icon, oneClick
   false, desktop + start-menu shortcuts, output to `dist/`.

**Milestone 5 — THE BIG ONE:** run

```bash
npm run build:win
```

and get `dist/APP_NAME Setup 1.0.0.exe`. Install it. The installed app does
everything Phases 1–4 promised, from the Start Menu, with the right icon.

---

### PHASE 6 — Auto-update (optional but strongly recommended)

**Tasks:**
1. `npm install electron-updater` (regular dependency, NOT dev).
2. Add to package.json build config:
   `"publish": [{ "provider": "github", "owner": "<me>", "repo": "<repo>",
   "releaseType": "release" }]` and script
   `"release": "electron-builder --win --x64 --publish always"`.
3. Wire `autoUpdater`: skip when `!app.isPackaged`; autoDownload; install on
   quit; on `update-downloaded` show "Restart Now / Later" dialog; on error
   log silently. Check on startup + every 4 hours. Show download progress on
   the Windows taskbar via `setProgressBar`.
4. Add an **Update** menu: "Check for Updates…" (manual check that ALWAYS
   answers — update available / you're on the latest / check failed) and a
   disabled "Current Version: vX.Y.Z" item.
5. Give me the release runbook (I use Git Bash):

```bash
git add -A && git commit -m "changes"
export GH_TOKEN="ghp_..."     # classic token, repo scope, no spaces around =
npm version patch             # bumps version + commits + tags automatically
npm run release               # builds + uploads installer & latest.yml to GitHub Releases
git push --follow-tags
```

**Milestone 6:** publishing a new version makes my installed app show the
"Update Ready — Restart Now?" dialog by itself. Remind me: the repo (or a
separate releases repo) must be PUBLIC, apps installed before Phase 6 need
one manual reinstall, and version numbers must never go backwards.

---

### Acceptance checklist (the agent should self-verify at the end)

- [ ] Login survives app restart; last page is restored
- [ ] Splash: greeting matches my clock, tagline shown, slow-hint after 12s
- [ ] Upload, normal download, blob/JS-generated download, CSV export all work
- [ ] Camera/mic prompt works on APP_DOMAIN and is denied elsewhere
- [ ] Offline → branded page → auto-reload on reconnect (no click needed)
- [ ] 404/500 → friendly error page with working Try Again
- [ ] Session expiry → login page + "session expired" toast, no dark screen
- [ ] Renderer crash → auto-recovery
- [ ] External links open in system browser (hostname-checked, not substring)
- [ ] Ctrl+F find bar, right-click menu with spellcheck, version tag on login
- [ ] Second launch focuses the existing window; window size remembered
- [ ] `npm run build:win` produces a working installer
- [ ] (Phase 6) Auto-update loop verified end to end

---

*End of prompt. Fill the CONFIG block, paste to your agent, and build each
phase's milestone before continuing. From experience: Phases 1–5 fit
comfortably in a single working session.*
