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
npm run cap:sync    # vite build + copy the fresh dist/ into android/
npm run cap:open    # open the project in Android Studio → Run / Build APK
```

Every time you change the web, re-run `npm run cap:sync` before building. That is the
whole propagation story: web change → `cap:sync` → APK.

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
behavior: local dictionary + dictionaryapi.dev, vocabulary stays device-local and
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
