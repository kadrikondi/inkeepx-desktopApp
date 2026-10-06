# How to Add Auto-Update to Your Electron Desktop App (with GitHub Releases)

*A complete, battle-tested guide — every step, every error you'll hit, and how to fix it.*

---

Shipping an Electron desktop app is easy. Shipping **updates** to it is where most
developers get stuck. Without auto-update, every bug fix means asking users to
manually download and run a new installer — and most of them never will.

This guide adds full auto-update to an Electron app using **electron-updater**
and **GitHub Releases** as the free hosting. When you're done, your release
process is three commands, and every installed copy of your app updates itself.

**What the finished system does:**

- The app checks GitHub for a new version on every launch (and every 4 hours).
- Updates download silently in the background while the user works.
- The user gets a "Restart Now / Later" dialog. If they pick Later, the update
  installs automatically the next time they quit.
- Optionally, a "Check for Updates" menu item lets users check on demand.

**What you need before starting:**

- An Electron app that already builds an installer with **electron-builder**
- A **GitHub account** and your app's code in a GitHub repository
- The repository must be **public** (or see the alternatives at the end)
- Node.js and npm installed

---

## Step 1 — Install electron-updater

In your project folder:

```bash
npm install electron-updater
```

⚠️ **Important:** `electron-updater` must be in `dependencies`, NOT
`devDependencies`. It runs inside the packaged app on the user's machine.
Running `npm install electron-updater` (without `-D`) does this correctly.
Verify in package.json:

```json
"dependencies": {
  "electron-updater": "^6.0.0"
}
```

---

## Step 2 — Tell electron-builder where releases live

In package.json, inside the `"build"` section, add a `publish` block with your
GitHub username and repository name:

```json
"build": {
  "appId": "com.yourcompany.yourapp",
  "productName": "YourApp",
  "publish": [
    {
      "provider": "github",
      "owner": "YOUR_GITHUB_USERNAME",
      "repo": "YOUR_REPO_NAME",
      "releaseType": "release"
    }
  ],
  ...
}
```

Don't skip `"releaseType": "release"`. Without it, electron-builder uploads
every release as a **draft** — and draft releases are invisible to the updater.
You'd have to open GitHub and click "Publish release" by hand every time.
(If you *want* to review releases before they go live, leave it out on purpose.)

Also add a release script to `"scripts"`:

```json
"scripts": {
  "release": "electron-builder --win --x64 --publish always"
}
```

---

## Step 3 — Add the updater code to your main process

In your main process file (usually `main.js`), require the updater at the top:

```js
const { autoUpdater } = require('electron-updater');
```

Then add this function and call it after you create your main window:

```js
function setupAutoUpdate() {
  // Updates only work in the installed app, never in development
  if (!app.isPackaged) return;

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;  // installs silently on quit

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWin, {
      type:      'info',
      title:     'Update Ready',
      message:   `Version ${info.version} has been downloaded.`,
      detail:    'Restart the app to apply the update.',
      buttons:   ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    // Never bother the user about failed checks — just log them
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates();
  // Re-check every 4 hours while the app stays open
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}
```

**Optional but recommended — a "Check for Updates" menu item** so users can
check on demand and get feedback either way:

```js
let manualCheck = false;

function checkForUpdatesManually() {
  if (!app.isPackaged) return;
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

// Inside setupAutoUpdate(), add:
autoUpdater.on('update-not-available', () => {
  if (manualCheck) {
    manualCheck = false;
    dialog.showMessageBox(mainWin, {
      type: 'info',
      message: `You're on the latest version (v${app.getVersion()}).`,
    });
  }
});

// And in your menu template:
{ label: 'Check for Updates…', click: checkForUpdatesManually }
```

---

## Step 4 — Get a GitHub token (needed to publish, not to update)

electron-builder needs permission to create releases in your repository.
That's what the token is for. **Your users never need it** — their apps
download from the public release page with no authentication.

1. Go to **github.com** → click your avatar → **Settings**
2. Scroll to the bottom of the left sidebar → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)**
4. **Generate new token** → **Generate new token (classic)**
5. Give it a name like `electron-release`, pick an expiration
6. Tick exactly one scope: **`repo`**
7. Click **Generate token** and **copy it immediately** — GitHub only shows
   it once. It looks like `ghp_xxxxxxxxxxxxxxxxxxxx`.

**Token safety rules:**

- Never commit the token to your repository. If you keep it in a `.env` file,
  make sure `.env` is listed in `.gitignore`.
- Never paste the real token into chats, issues, or screenshots. If a token
  ever leaks, delete it on GitHub and generate a new one — it takes 30 seconds.
- You only need the token on the machine that publishes releases.

---

## Step 5 — Publish your first release

This is the process you'll repeat for every release. Three rules first,
because they cause almost every failure:

1. **Commit everything before you start.** `npm version` refuses to run with
   uncommitted changes ("Git working directory not clean").
2. **Never edit the version number by hand.** `npm version patch` bumps
   package.json, makes a commit, and creates a git tag — all consistently.
3. **The shell matters.** Setting the token uses different syntax in
   PowerShell vs Git Bash.

**In Git Bash:**

```bash
git add -A
git commit -m "describe your changes"

export GH_TOKEN="ghp_your_token_here"    # no spaces around the = sign!
npm version patch        # e.g. 1.0.0 -> 1.0.1 (commit + tag created for you)
npm run release          # builds the installer and uploads it to GitHub
git push --follow-tags   # push your commits AND the version tag
```

**In PowerShell:**

```powershell
git add -A
git commit -m "describe your changes"

$env:GH_TOKEN = "ghp_your_token_here"
npm version patch
npm run release
git push --follow-tags
```

Common first-run errors, decoded:

| Error | Cause | Fix |
|---|---|---|
| `bash: :GH_TOKEN: command not found` | PowerShell syntax (`$env:`) used in Git Bash | Use `export GH_TOKEN="..."` |
| `export: '=': not a valid identifier` | Spaces around `=` in bash | `export GH_TOKEN="..."` — no spaces |
| `npm error Git working directory not clean` | Uncommitted changes | Commit everything first |
| `GitHub Personal Access Token is not set` | Token not exported in this terminal | Re-run the export line (it only lasts per terminal session) |
| HTTP 401/404 during upload | Wrong token, missing `repo` scope, or wrong owner/repo in package.json | Regenerate token, check the publish block |

---

## Step 6 — Verify the release on GitHub

Open `https://github.com/YOUR_USERNAME/YOUR_REPO/releases`. You should see the
new version marked **Latest** (not *Draft*), containing at least:

- `YourApp Setup 1.0.1.exe` — the installer
- `latest.yml` — **this file is the heart of the whole system.** Installed
  apps download it to learn what the newest version is. Never delete it.
- a `.blockmap` file — enables differential (smaller) update downloads

If the release shows as **Draft**, the updater can't see it. Click the release
→ Edit (pencil icon) → **Publish release**. Then add
`"releaseType": "release"` to your publish config (Step 2) so it doesn't
happen again.

---

## Step 7 — The one-time bootstrap (read this, it catches everyone)

Auto-update code can only update apps that **already contain auto-update code**.

Any copy of your app installed *before* you added the updater has no idea
GitHub Releases exist. It will sit on its old version forever, no matter how
many releases you publish.

So, one time only: download the new installer from the GitHub release page
and install it manually on each machine (it installs right over the old
version — user data and login sessions are preserved). From that install
onward, updates are automatic forever.

---

## Step 8 — Watch the full loop work

Prove it end-to-end:

1. Install the app from your published release (say v1.0.1).
2. Make any tiny change, then run the Step 5 commands again → v1.0.2 goes up.
3. Launch your installed v1.0.1 — within about 30 seconds, the "Update Ready —
   Restart Now?" dialog appears (or use your Check for Updates menu).
4. Restart. Your app is v1.0.2. That's the loop your users will live in.

---

## Rules to never break

- **Never lower or reuse a version number.** The updater only moves forward.
- **The repo (or at least its releases) must stay public**, or updates
  silently stop working for users.
- **If you ever code-sign your app, sign every release from then on.**
  A signed app refuses updates from an unsigned build, and vice versa.
- **Pushing code does not update anyone.** Only publishing a *release* does.

---

## Alternatives if you don't want a public repository

**Private code, public releases:** create a second, empty public repo (e.g.
`yourapp-releases`) and point the `"repo"` field of the publish config at it.
Your source stays private; only installers are public.

**Your own server:** electron-builder's `generic` provider works with any
static HTTPS file host (S3, nginx, etc.):

```json
"publish": [{ "provider": "generic", "url": "https://updates.yourapp.com/desktop" }]
```

Upload the installer + `latest.yml` from your `dist/` folder to that URL on
each release. Everything else in this guide stays the same.

---

*That's the whole system: ~40 lines of code, one config block, one token, and
a three-command release flow. Your users just see an app that's always
up to date.*
