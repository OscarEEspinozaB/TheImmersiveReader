# Desktop app (Tauri)

The desktop app is **not a second codebase**. It is the same web app (`src/` → `dist/`)
in a native window, built with [Tauri 2](https://tauri.app). Linux is the supported
platform today. On Linux, Tauri renders with WebKitGTK.

## Build and run

Debian/Ubuntu build dependencies:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

A Rust toolchain is also required.

```bash
npm run desktop:dev    # a native window on the Vite dev server (port 5173)
npm run desktop:build  # builds the web, then the installers
```

`desktop:build` writes to `src-tauri/target/release/bundle/`:

| Package | Path | Notes |
|---|---|---|
| AppImage | `appimage/The Immersive Reader_<version>_amd64.AppImage` | Runs without installing; bundles its libraries (about 108 MB) |
| Debian package | `deb/The Immersive Reader_<version>_amd64.deb` | Uses the system's WebKitGTK (about 5 MB) |

## Layout

| Path | Purpose |
|---|---|
| `src-tauri/tauri.conf.json` | Window, bundle targets, web build location |
| `src-tauri/capabilities/default.json` | What the window may do |
| `src-tauri/src/lib.rs` | Registers the plugins |
| `src-tauri/icons/` | Generated from `assets/icon-only.png` with `npx tauri icon` |
| `src/desktop.js` | `isDesktopApp` and the link handling below |

## What differs from the browser

| Area | Desktop behavior |
|---|---|
| **New-tab links** | `window.open()` and `<a target="_blank">` open in the system browser (opener plugin). |
| **Paste** | `src/clipboard.js` reads text through the clipboard plugin. The link prompt pre-fills from a copied URL, as on the phone. |
| **Import from a link** | `src/webImport.js` fetches pages and pictures through the HTTP plugin, so CORS does not apply and no home server is needed. The `/fetch` proxy stays the fallback. |
| **File pickers** | The existing file inputs open the native GTK chooser. |
| **Downloads** | Exports go straight to the system's Downloads folder, with no prompt. |
| **Home server** | Requests from the app's `tauri://localhost` origin reach the plain-HTTP LAN server directly. |
| **Local data** | The app has its own library and settings, separate from any browser's. They persist across restarts. Vocabulary and reading position sync through the home server as usual. |

## Read-aloud on Linux

The app uses WebKitGTK's Web Speech engine, which limits read-aloud:

- It offers four en-US Flite voices and no Spanish voice.
- It sends no word-boundary events, so the highlight does not follow each word.
- Continuous reading can stall partway through a paragraph.

## Updates

The desktop app does not update itself. To ship any change to it, web or native, run
`npm run desktop:build` and install the new package.
