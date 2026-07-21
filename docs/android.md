# Android APK (Capacitor)

The Android app is **not a second codebase**. It is the exact same web app
(`src/` → `dist/`) wrapped in a native WebView by [Capacitor](https://capacitorjs.com/).
There is one source of truth — the web — and the APK embeds a build of it. Any change
to the reader is a web change; you never edit app logic in `android/`.

## Why a WebView (and not native)

The app is already fully client-side and works offline (localStorage + IndexedDB,
books in IndexedDB, dictionaries local, the home-server optional). There is no second
business logic to share, so there is nothing to extract into a "core" module: the web
*is* the core. A native (Kotlin) UI would mean rewriting everything the browser
already does for no product gain. Capacitor keeps the web as-is and just packages it.

A WebView also **hardens storage**: in Capacitor, `localStorage`/IndexedDB are the
app's private, persistent data — not the evictable browser cache the web version
lives in. The same storage code becomes more durable on the phone for free.

## Layout

```text
src/                      the web app — the single source of truth (unchanged)
dist/                     vite build output; Capacitor copies this into the APK
app.config.json           centralized build-time DEFAULTS (server IP, languages…)
capacitor.config.json     appId, webDir=dist, cleartext LAN scheme
android/                  generated native project (one sibling folder)
```

## Build workflow

Requirements: Android Studio (bundles the Android SDK) and a JDK. Node builds the web.

```bash
npm run cap:sync                      # vite build + copy the fresh dist/ into android/
cd android && ./gradlew assembleDebug # → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run cap:open` opens the same project in Android Studio instead, if you prefer
Run/Build from the IDE.

Two settings differ from Capacitor 6's defaults, both forced by the OTA updater
plugin and both in build files that are committed:

- `minSdkVersion = 23` (was 22) in [variables.gradle](../android/variables.gradle) —
  the plugin pulls Play-services libraries that declare 23.
- `androidx.work:work-runtime` pinned to **2.9.1** in
  [app/build.gradle](../android/app/build.gradle) — the plugin hardcodes 2.10.5,
  which refuses any project compiling below SDK 35, and this one is on 34. Drop the
  pin when the project moves to compileSdk 35+.

Day to day you rarely run any of this: a **web** change ships with
`npm run app:publish` (see OTA below) and reaches the installed APK by itself. The
build above is only for **native** changes — a plugin, `android/`,
`capacitor.config.json`, icons — which cannot travel over the air and need the APK
installed by hand. Publish after a native build too, so the APK's embedded bundle and
the published one don't drift apart.

## Over-the-air web updates (OTA)

Rebuilding and reinstalling the APK for every web change is the wrong loop when the
APK *is* the web. The shell instead pulls new web bundles from the home server on the
LAN, so a change reaches the phone by restarting the app — no reinstall, no store.

```bash
npm run app:publish   # vite build + publish the bundle to the home server's data/app/
```

- **Server** — `npm run app:publish` zips `dist/` into `data/app/<version>.zip` and
  points `data/app/latest.json` at it (version = package version + a build stamp,
  e.g. `0.1.0-202607181530`). It is served read-only at `/app/latest` and
  `/app/bundle.zip`; the last 3 bundles stay on disk, so re-publishing an older
  build is the rollback. Publishing is a **local** command — no HTTP endpoint lets a
  device push code to the others.
- **Phone** — on start, [src/appUpdate.js](../src/appUpdate.js) asks `/app/latest`,
  compares the version with the one it is running (**equality**, never ordering — the
  server decides what the phones should run) and, when they differ, downloads the zip
  with [`@capgo/capacitor-updater`](https://github.com/Cap-go/capacitor-updater),
  which unzips it and swaps the WebView's asset directory.

### When it updates

Checking and downloading are **automatic, at every app start**. What is not
automatic is *applying*: the bundle is staged for the next start (rule 3 below), so
the sequence is publish → open the app (downloads) → open it again (runs the new
one), or press "Restart now" on the bar that appears to skip the wait.

Because of that, "did it update?" is a real question, and the menu answers it
without being opened past the first screen: the settings flyout ends with a
permanent footer line — the running bundle version and where updates come from,
or, when one is waiting, `Update <version> downloaded — restart to apply` in the
learning color. It sits *outside* the collapsible sections on purpose.

### Settings — and the way back

A WebView has no address bar, so everything the OTA flow needs must be reachable
*inside* the app. Settings → **App updates** (shown only in the APK — the web is
always served whatever build its host has) holds three things:

- **Update URL** — where the bundle is fetched from. Empty means "same as the Home
  server URL", which is the normal case: `npm run app:publish` writes into that same
  server's `data/app/`. Set it only to serve updates from a different machine. The
  shipped default lives in [app.config.json](../app.config.json) (`server.updateUrl`).
- **Check for updates** — the same check the app does at start, on demand, and it
  *reports back*: downloaded / already up to date / the actual error text. Without it
  a silent boot check is indistinguishable from a broken one.
- **Go back to previous version** — the escape hatch. Steps back **one** bundle, to
  the last one that worked; every good update before it is kept. It only lands on the
  APK's built-in bundle when there is no earlier good one — same behavior as the
  automatic rollback. This is what makes a bad update recoverable without
  reinstalling: rule 2 only catches bundles that fail to *boot*, not ones that boot
  and misbehave.

Four rules keep it from ever bricking the app:

1. **Never a dependency.** No server, no LAN, nothing published, plugin missing — all
   no-ops, and the bundle embedded in the APK keeps working fully offline. It is also
   a plain no-op on the web build.
2. **Rollback on a bad bundle.** Every start calls `notifyAppReady()`. A bundle that
   fails to boot never reaches that call, and the native side reverts to the last
   bundle that *worked* — one step back, not down to the APK's built-in one (that is
   only the last resort when no good bundle remains).
3. **Never swapped mid-sentence.** A downloaded bundle is *staged* (`next()`), so it
   applies at the next app start. A dismissible bar offers the immediate switch as a
   visible button — the same interaction rule as the rest of the app.
4. **There is always a way back** — the manual step-back above, reachable from
   inside the app, for a bundle that boots but misbehaves.

Reinstalling the APK is still needed for **native** changes only: a new plugin, an
icon, `MainActivity`, or `capacitor.config.json`. Installing a new APK resets the app
to its embedded bundle (`resetWhenUpdate`), which then updates OTA again as usual.

## App icon

The launcher icon is the app's own metallic-owl-on-a-book logo (the same mark as the
web favicon), not the Capacitor default. The 1024×1024 sources live in `assets/`:

- `icon-only.png` — full-bleed owl on black (legacy / round icons).
- `icon-foreground.png` — owl scaled into the adaptive-icon safe zone, transparent
  margin (Android 8+ adaptive foreground).
- `icon-background.png` — solid black (adaptive background; the art is on black, so
  foreground and background seams vanish).

Regenerate every density + the adaptive `mipmap-anydpi-v26` XML after changing a
source:

```bash
npm run cap:icons
```

That runs `@capacitor/assets` with a black icon background. The `assets/` sources are
versioned so anyone can rebuild the icons; the generated `mipmap-*` files under
`android/` are committed too (they are project source, not build output).

## WebView vs. browser — platform gaps handled

The Android System WebView is not a full browser; a few web APIs the reader relies
on are missing or behave differently. Each is bridged to a native equivalent:

- **Read-aloud (TTS).** The WebView has no Web Speech API (`window.speechSynthesis`
  is absent), which would silently hide every 🔊 button and the voice settings. On
  native, `src/speech.js` routes speech through
  [`@capacitor-community/text-to-speech`](https://github.com/capacitor-community/text-to-speech)
  (the OS TTS engine) instead; the web keeps using Web Speech. `canSpeak()` is true
  on both. The voice picker lists the OS voices via `getSupportedVoices()`.
- **Hardware back button.** Capacitor's default is to exit the app. `src/main.js`
  registers an `@capacitor/app` `backButton` handler that instead: closes an open
  menu/bubble/popup first, else steps the reader or a hub back to the library, and
  only exits from the library itself. No-op on the web (the event never fires).
- **Font size.** The browser's pinch/zoom isn't available, so the reader has its own
  **Size** setting (Settings → Reading → Size) applied as the `--reader-font-size`
  CSS multiplier. It benefits the web build too. Default in `app.config.json`.
- **Edge-to-edge.** By default the WebView stops between the two opaque system bars.
  Two pieces make it reach both edges: `src/statusBar.js` uses
  [`@capacitor/status-bar`](https://capacitorjs.com/docs/apis/status-bar) to overlay a
  transparent *status* bar (`setOverlaysWebView`), and `MainActivity` calls
  `WindowCompat.setDecorFitsSystemWindows(window, false)` with a transparent
  navigation bar so the *bottom* is edge-to-edge too (the plugin only handles the
  top). The CSS already reserves both gaps with `env(safe-area-inset-top/bottom)`
  (`--sat/--sab`, and `--sal/--sar`), so nothing is covered. Status-bar icon contrast
  follows the theme: `src/reader/theme.js` calls `syncStatusBarStyle(mode)` on every
  theme change — light themes get dark icons, dark themes get light icons. No-op on
  the web, where the browser owns the chrome.
- **Immersive reading.** In the reader the phone's status bar hides *with* the app's
  own chrome and comes back with it, so a page of text has nothing on screen but
  text — no clock, no notification icons. `setImmersive()` in `src/statusBar.js`
  drives `StatusBar.hide()/show()` off the same auto-hide timer as the top/bottom
  bars (`showChrome`/`hideChrome` in `main.js`); leaving the reader always restores
  it. Android keeps the bar reachable by a swipe from the top edge, and it slides
  away again on its own. Two details worth keeping:
  - Restoring is **unconditional** — `showChrome` also runs outside the reader —
    so the bar can never be stranded hidden over a hub view. Coming back from the
    background re-asserts it (`appStateChange`), because Android restores the
    system bars on resume by itself.
  - The freed inset is reclaimed **only in continuous mode** (`body.immersive
    .reader-wrap--scroll`), mirroring the chrome's own rule. Zeroing `--sat`
    globally would shift the text column and **repaginate the book every time the
    bars time out**.

## Talking to the home-server from the phone

The client reaches the home-server (dictionary KB, AI explanations, vocabulary and
reading-position sync) over the LAN. Two things make that work on Android:

1. **The default URL is centralized in [app.config.json](../app.config.json)**
   (`server.defaultUrl`). On the phone it must be the server machine's **LAN IP**
   (e.g. `http://192.168.100.6:4321`), never `localhost`. The user can still override
   it at runtime in Settings; the config is only the shipped default.
2. **Cleartext HTTP is explicitly allowed** for the LAN. Android 9+ blocks plain HTTP
   by default, so [network_security_config.xml](../android/app/src/main/res/xml/network_security_config.xml)
   opts back in and the manifest references it. This is a trusted-LAN personal app; if
   the server ever moves behind HTTPS, tighten that file back down.

When the server is unreachable (away from home), the app degrades to its offline
behavior: local dictionary + freedictionaryapi.com, vocabulary stays device-local and
syncs on the next connection. Nothing breaks.

## What lives in git

The `android/` project source is committed. Build artifacts are not — see
`.gitignore` (the `android/app/src/main/assets/public/` web copy is regenerated by
`cap:sync`, plus `*/build/`, `.gradle/`, `local.properties`, `*.apk`/`*.aab`).

## Centralized defaults — `app.config.json`

All shipped defaults live in one file so re-shipping a different home-server IP or a
different default language never means touching code. It is imported at build time by
[src/settings.js](../src/settings.js). Everything in it is a **default only**: the
user overrides any value in Settings and their choice (persisted in localStorage)
always wins.
