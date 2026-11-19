# Desktop app (Tauri)

The desktop app is **not a second codebase**. It is the same web app (`src/` → `dist/`)
in a native window, built with [Tauri 2](https://tauri.app). Linux is the supported
platform today. On Linux, Tauri renders with WebKitGTK.

## Build and run

Debian/Ubuntu build dependencies:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf
```

A Rust toolchain is also required.

```bash
npm run desktop:dev    # a native window on the Vite dev server (port 5173)
npm run desktop:build  # builds the web, then the installers
(cd src-tauri && cargo test --lib)  # tests for voice downloads and incoming files
```

`desktop:build` writes to `src-tauri/target/release/bundle/`:

| Package | Path | Notes |
|---|---|---|
| AppImage | `appimage/The Immersive Reader_<version>_amd64.AppImage` | Runs without installing; bundles its libraries and audio components (about 190 MB) |
| Debian package | `deb/The Immersive Reader_<version>_amd64.deb` | Uses the system's WebKitGTK (about 5 MB) |

## Layout

| Path | Purpose |
|---|---|
| `src-tauri/tauri.conf.json` | Window, bundle targets, web build location |
| `src-tauri/capabilities/default.json` | What the window may do |
| `src-tauri/src/lib.rs` | Registers the plugins and native commands |
| `src-tauri/src/voice.rs` | Downloads the voices and runs the speech engine |
| `src-tauri/src/files.rs` | Receives dropped files and files sent by "Open with" |
| `src-tauri/linux/` | The `.deb`'s desktop entry and the `.tir` file type |
| `src-tauri/icons/` | Generated from `assets/icon-only.png` with `npx tauri icon` |
| `src/desktop.js` | `isDesktopApp` and the link handling below |
| `src/desktopVoice.js` | Plays the native voices and estimates the spoken word |
| `src/desktopFiles.js` | The drag hint, and hands incoming files to `main.js` |

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

## Adding files

Files can be dragged onto the window or sent from the file manager with "Open with". The
app reads `.pdf`, `.epub`, `.md`, `.markdown`, `.txt`, `.text` and `.tir`.

| File | Where it goes |
|---|---|
| PDF, EPUB, `.tir` | My Books |
| Text or Markdown dropped on My Books | My Books |
| Text or Markdown dropped anywhere else, or sent by "Open with" | Notes |

- **One file** behaves like choosing it in the app: the same questions, then it opens.
- **Several files** share one language question (`.tir` files carry their own language).
  They are added to the library without opening. A closing message lists any file that
  was already there, could not be read, or is of another type. Cancelling the question
  adds nothing.
- **While editing a note,** dropped text goes in at the cursor and the draft is kept. Other
  file types are refused until the note is saved.
- **While the app is running,** "Open with" brings its window forward instead of starting
  a second copy. Files that arrive during a dialog wait for it to finish.

The `.deb` registers the app for these file types, so it appears under "Open with"
without replacing the default application for any of them. The AppImage does not register
itself with the desktop. It accepts files by drag and drop, or on its command line:

```bash
./"The Immersive Reader_<version>_amd64.AppImage" book.pdf
```

The web page never handles paths. `src-tauri/src/files.rs` gives each offered file an id
that can be read once, so a page shown in the app cannot read other files on the disk.

## Read-aloud on Linux

WebKitGTK's Web Speech has no Spanish voice and no word events, so the app reads aloud
with [Piper](https://github.com/rhasspy/piper), a local neural engine:

1. The first time a language is read, a dialog asks to download its voice. About 64 MB
   per voice, plus 26 MB for the engine the first time.
2. `src-tauri/src/voice.rs` downloads from pinned addresses into the app's data folder
   and checks each engine and voice file against its SHA-256 before using it.
3. It keeps the engine running and turns each sentence into a WAV file.
4. `src/desktopVoice.js` plays the sentences in order and prepares the next one ahead.

After the download, reading works offline.

| Language | Voices (first is the default) |
|---|---|
| English | Lessac (US), Alba (UK) |
| Spanish | Claude (Mexico), Davefx (Spain) |
| French | Siwis |
| German | Thorsten |
| Italian | Paola |
| Portuguese | Faber (Brazil) |

- **Korean** has no voice; the app says so.
- **Choosing a voice:** Settings → Voice lists the language's voices. One not yet on the
  device is marked `· download` and is offered for download when first used.
- **Word highlight:** the engine reports no word timings, so the highlight is estimated
  from word length and punctuation. It can run slightly ahead of or behind the voice.
- **Speed:** Settings → Voice speed changes playback speed and keeps the pitch.
- **Engine version:** this Piper release is from 2023. Newer voice files list phonemes it
  rejects, so the installed copy of each voice configuration omits those entries.

## Updates

The desktop app does not update itself. To ship any change to it, web or native, run
`npm run desktop:build` and install the new package.
