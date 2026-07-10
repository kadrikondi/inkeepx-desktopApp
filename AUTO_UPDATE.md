# Auto-Update Setup Guide (electron-updater + GitHub Releases)

> **Status: already implemented.** The updater code is live in `src/main.js`
> (`setupAutoUpdate`), the publish config is in `package.json`, and
> `electron-updater` is installed. Steps 2–4 below are kept as reference for
> how it was done. What's left for you: make the repo public, then use the
> quick reference below whenever you ship a new version.

## Quick reference — shipping a new version

Users getting updates only happens once you **publish a release**. Pushing
code to GitHub does nothing for installed apps. Next time you have a new
version to ship, the flow is:

```powershell
$env:GH_TOKEN = "ghp_your_token"     # token with repo scope, only on your machine
npm version patch                     # 1.0.1 -> 1.0.2
npm run release                       # builds + uploads installer to GitHub Releases
```

That's it — installed apps pick it up on their next launch or 4-hour check.

---

This guide adds automatic updates to InkeepX Desktop: the app checks GitHub
Releases on startup, downloads new versions in the background, and installs
them when the user quits.

## How it works

1. You push a git tag like `v1.0.1` (or run the publish command manually).
2. `electron-builder` builds the installer and uploads it to a **GitHub Release**
   together with a small `latest.yml` metadata file.
3. On every launch, the app (via `electron-updater`) fetches `latest.yml`,
   compares versions, and if a newer one exists, downloads it silently.
4. When the download finishes, the user is asked "Restart to update?" —
   or it just installs on next quit.

Users never download an installer manually again.

## Step 1 — Put the code on GitHub

The repo must be on GitHub (public or private). If private, the app needs no
token to *download* updates as long as you publish to public releases;
fully private repos require a token or a generic file server instead
(see "Alternatives" below).

## Step 2 — Install electron-updater

```bash
npm install electron-updater
```

Note: `electron-updater` goes in `dependencies` (it runs inside the packaged
app), not `devDependencies`.

## Step 3 — Add publish config to package.json

In the `"build"` section:

```json
"build": {
  "appId": "com.inkeepx.desktop",
  "productName": "InkeepX",
  "publish": [
    {
      "provider": "github",
      "owner": "YOUR_GITHUB_USERNAME_OR_ORG",
      "repo": "inkeepx-desktopApp"
    }
  ],
  ...
}
```

Also make sure `"version"` in package.json is bumped for every release —
the updater compares this version against the latest release tag.

## Step 4 — Add the updater code to src/main.js

```js
const { autoUpdater } = require('electron-updater');

function setupAutoUpdate() {
  // Don't check in development
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // installs silently on quit

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWin, {
      type:    'info',
      title:   'Update Ready',
      message: `InkeepX ${info.version} has been downloaded.`,
      detail:  'Restart the app to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    // Never bother the user about update failures — just log
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates();
  // Re-check every 4 hours while the app stays open
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}
```

Call `setupAutoUpdate()` at the end of `createWindow()`.

## Step 5 — Publish a release

Create a GitHub personal access token with the `repo` scope
(GitHub → Settings → Developer settings → Personal access tokens), then:

```powershell
$env:GH_TOKEN = "ghp_yourtoken"
npm version patch          # bumps 1.0.0 -> 1.0.1 and creates a git tag
npx electron-builder --win --x64 --publish always
```

This builds the NSIS installer, creates a GitHub Release for the current
version, and uploads the installer + `latest.yml`.

> The token is only needed on the machine that **publishes**. End users'
> apps download from the public release URL without any token.

## Step 6 — Test the cycle

1. Install the app from the published v1.0.1 installer.
2. Bump to v1.0.2, publish again.
3. Launch the installed v1.0.1 → within ~30 s you should see the
   "Update Ready" dialog. Restart → app is v1.0.2.

## Important caveats

- **Code signing:** unsigned Windows apps update fine, but SmartScreen will
  warn on the first install. If you later buy a code-signing certificate,
  sign *every* release from then on — a signed app refuses updates from an
  unsigned build and vice versa.
- **Never downgrade** the version number; the updater ignores older versions.
- **`latest.yml` must stay next to the installer** in the release — it's
  uploaded automatically, don't delete it.
- Draft releases are ignored; the release must be **published**.

## Alternatives to GitHub Releases

If GitHub doesn't fit, `electron-builder` supports a `generic` provider —
any static HTTPS file server (S3 bucket, your own nginx, etc.):

```json
"publish": [{ "provider": "generic", "url": "https://updates.inkeepx.com/desktop" }]
```

Then upload the contents of `dist/` (installer + `latest.yml`) to that URL
on each release. Everything else in this guide stays the same.
