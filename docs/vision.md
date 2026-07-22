# The Immersive Reader — Vision (the one future-plans document)

> This is the **only** document that describes future work. Every other document in
> this repository describes what is actually implemented. When something here gets
> built, move its description into the matching implemented doc and delete it from
> this file. Last consolidated 2026-07-02 (absorbed `idea.md`, `ES_Ideas_Futuras/*`,
> and the pending sections of the old design docs).

## 1. North star

The product goal stays what it always was: read real books in a language you are
learning, watch the "red sea" of unknown words fade as your vocabulary grows, and
get explanations that meet you at your level. The single most important future
capability is:

- **Explanations constrained to words the user already knows.** No training or
  fine-tuning — pass the user's known-words list into the prompt (in-context) and
  instruct the model to explain using only those words. This makes explanations
  progressively easier as the vocabulary grows, closing the product's core loop.
  **Gated by hardware, not desire** (owner's call, 2026-07-02): honoring a long
  known-words constraint reliably needs a stronger model than the home CPU runs
  comfortably today. Revisit when the local hardware (or small-model quality)
  catches up.

## 2. Decided architecture direction

The client/server split already happened (see [home-server.md](home-server.md)) and
settled the old open question:

- **The server is Node + SQLite on the home LAN.** The earlier Phase-2 sketch
  (Rust backend, centralized PostgreSQL, Ollama cluster) is **retired**. It only
  becomes relevant again if the system ever leaves the LAN for the public internet
  or grows past one household — at that point it is a rewrite with real auth and
  real verification, not an increment.
- **Ingestion stays on the client.** The server receives processed `.tir` books,
  never raw PDFs/EPUBs. This keeps it thin and format-agnostic.
- **Packaging:** the decided path for a phone install is a **native Android app
  built with Capacitor** (see §2a) — a signed, sideloadable APK, not only a PWA.
  Capacitor wraps the exact Vite build in a WebView shell, so the codebase is
  reused as-is. PWA (§3) stays the zero-install option for desktop and
  non-Android devices; Tauri 2 remains a theoretical desktop fallback but is not
  being pursued while Capacitor covers the concrete need (Android on the home LAN).

### 2a. Android app (Capacitor)

Goal: a real installable Android app (`.apk` for sideload), not a browser tab.
**Capacitor** is chosen over Tauri and a bare PWA because it reuses the current
static Vite output unchanged, ships a mature Android WebView toolchain, and has a
plugin for each native gap below.

- **Identity & build pipeline.** App id `com.immersivereader.app`, display name
  "The Immersive Reader". The build is `vite build` → `npx cap sync android` →
  Gradle `assembleRelease`, producing a signed APK. `base: './'` in
  `vite.config.js` already emits the relative asset paths Capacitor's local
  scheme needs; the pdf.js worker is bundled through a Vite `?url` import
  (`src/ingest/pdf.js`), so nothing loads from a CDN and the reader works offline
  in the WebView. `localStorage` + IndexedDB persist in the WebView.
- **The LAN-over-HTTP resolution (the one real obstacle).** The home server is
  plain `http://…:4321`; Android blocks cleartext by default, and blocks mixed
  content when the app itself runs on `https://localhost`. The decided fix: set
  `server.androidScheme: "http"` in `capacitor.config` so the app runs at
  `http://localhost` — the same scheme as the server, so fetches to
  `http://<lan-ip>:4321` are no longer mixed content — and ship a
  `network_security_config.xml` permitting cleartext to the LAN with
  `android:usesCleartextTraffic="true"`. Everything server-facing
  (`src/definitions/kbApi.js`, `src/definitions/serverAi.js`, `src/vocabSync.js`,
  `src/serverLibrary.js`) then works unchanged, and away from the LAN the calls
  still fail soft into the offline behavior.
- **Native gaps → plugins & shims** (each small, behind an existing abstraction):
  - *External links.* `window.open("_blank")` does nothing useful in a WebView.
    A tiny `openExternal()` shim routes through `@capacitor/browser` when native
    (and falls back to `window.open` on the web). Callers: the link bubble
    (`src/gloss.js`) and the web-dictionary links (`src/popup.js`,
    `src/dashboard.js`).
  - *Hardware back button.* An `@capacitor/app` `backButton` handler maps to
    in-app navigation — close an open bubble/popup → return to the shelf → then
    allow exit — wired near the view switching in `src/main.js`.
  - *Text-to-speech.* Web Speech (`src/speech.js`) works on modern Android
    WebViews (it drives the system TTS engine), so it stays the default.
    `speech.js` already hides the API behind its own surface, so
    `@capacitor-community/text-to-speech` is a drop-in fallback if specific
    devices return no voices — adopted lazily, only if a device misbehaves.
  - *Clipboard.* `src/copy.js`'s existing `execCommand` fallback already covers
    the non-secure `http://localhost` context; `@capacitor/clipboard` is optional
    hardening, not required.
  - *Chrome.* `@capacitor/status-bar` (dark) + `@capacitor/splash-screen`; the
    layout already honors `env(safe-area-inset-*)`.
- **Signing & distribution.** A release keystore signs the APK; the keystore and
  its passwords are **gitignored** (never committed) and referenced from
  `android/app/build.gradle` `signingConfigs` via a local, untracked properties
  file. Distribution is sideload (APK), not the Play Store, so no AAB / Play
  signing. The generated `android/` project is committed for a reproducible
  build; `android/app/build/`, `.gradle/`, and secrets stay ignored.
- **Out of scope for the first APK:** Play Store publishing, push notifications,
  deep links, and any change to the offline-first data model — it is the same web
  client in a native shell.

## 3. Reader

- **Sentence-level rescue** (much later — owner, 2026-07-02): a "translate this
  sentence" action, server-brokered and cached like the word explanations, for
  the moments the words are known but the sentence still doesn't parse.
- **PWA (old milestone M4).** `vite-plugin-pwa` (manifest + service worker) was
  tried and reverted: installability over plain HTTP on the LAN required a
  locally-trusted certificate per device and the result didn't behave like a real
  installable app. Revisit with a concrete plan (likely: serve the client over
  HTTPS from the home server with a self-signed CA installed once per device).
  For Android specifically, the install story is now the Capacitor app (§2a); a
  PWA revisit would target desktop and non-Android devices.
- **PDF de-hyphenation joins real compounds.** `src/ingest/pdf.js` de-hyphenates a
  line wrap by dropping the hyphen and gluing the halves — right for `un-\nfortunate`,
  wrong when the hyphen is lexical, which is where `emerald-green` becomes
  `emeraldgreen` and `You-Know-Who` becomes `youknow`. Found while auditing the
  words the server's gap-fill could not define: these artifacts sit in that list
  permanently because no dictionary will ever have them. Likely fix: only glue when
  the joined form is a word the KB knows (or the second half is not a standalone
  word); otherwise keep the hyphen.

## 4. Dictionary knowledge base (server)

The KB serves refined English entries today. Still pending from the original
design (schema support already exists where noted):

- **Translations.** Per-sense translations into the user's native language
  (EN→ES first). The `translations` table already exists (keyed by `sense_id`,
  `target_lang` — open to N languages); what's missing is the generation pass
  (a purpose-built model such as `translategemma`, run as a separate batch) and
  surfacing translations in the popup/Dictionary hub. The **reader** no longer waits
  on this: the on-demand "Translate to `<native>`" button already answers away from
  home, on-device and in every direction (docs/design.md, docs/android.md). What is
  still missing is translation as *KB data* — stored per sense, shared across devices,
  visible in the Dictionary hub and in the family card, rather than produced live for
  one tap and forgotten.
- **Gap-fill parsers for the remaining editions.** The server now seeds missing
  words from public dictionaries (`generate/gapfill.js`, see docs/home-server.md):
  `en` from freedictionaryapi.com, `es`/`fr`/`it`/`pt` from their own Wiktionary
  editions. **German and Korean still have none** — de.wiktionary lays definitions
  out as `<dl>`/`<dd>` under *Bedeutungen* rather than the `<ol>`/`<li>` the other
  editions use, so it needs its own parser; until then those words stay `absent`.
  Also open: seeding stores only the FIRST sense for the Wiktionary editions (the
  refiner reads up to eight for English), and no inflections for them, so a seeded
  language has no word families yet.
- **Field locking + manual edits.** Provenance rows are already stamped (with a
  `locked` guard in SQL), but nothing sets `locked = 1` yet: there is no UI to
  edit an entry by hand. The contract to build: a manual edit locks that field
  forever; re-refine passes only touch `ai`-sourced, unlocked fields; a pin icon
  marks locked fields in the Dictionary hub.
- **Unattended batch generation.** Today batch building is a foreground CLI
  (`npm run build:book`). The original plan's nightly, resumable, thermally
  guarded job (write `generation_progress` — the table exists —, poll
  `lm-sensors`, pause above ~80 °C, run under `nice`/`ionice`) is still worth
  building for whole-library runs, because CPU inference on the home machine is
  ~5–25 s per word.
- **Portable KB export (`.tirdict`).** A zip (manifest + streamed NDJSON of
  entries) per language, mirroring the `.tir` book format, so a generated KB can
  be carried to a machine that never talks to the server. Lower priority now that
  the LAN service exists; useful for true offline travel.
- **LLM-from-scratch entries.** In-universe coinages (*Quidditch*, *Muggle*) are
  now covered by the external gap-fill above. What is left is the word absent from
  the dump AND from every public dictionary — invented names, heavy slang. For
  those an LLM pass could still generate and store an entry (provenance `ai`, no
  offline source).

### 4a. More languages

The schema is multilingual by construction (`lang` on every entry). A dump is no
longer the price of entry: **es/fr/it/pt already have a KB**, seeded on demand from
their own Wiktionary editions by the server's gap-fill, and the client answers them
directly too (`nativeWiktionary` for Spanish, `freeDict`'s English translation
elsewhere). What a full **Kaikki/Wiktextract dump** would still add is bulk offline
coverage (no network per word), many senses instead of one, and the inflection data
that word families need — which is what the table's "Status" tracks, alongside the
tokenizer work noted per language.

| Code | Language | Tokenizer readiness | Status |
| --- | --- | --- | --- |
| `es` | Spanish | `Intl.Segmenter` — ready today | Seeded (gap-fill); dump next |
| `pt-BR` | Portuguese | `Intl.Segmenter` — ready today | Seeded (gap-fill) |
| `fr` / `it` | French / Italian | `Intl.Segmenter` — ready today | Seeded (gap-fill) |
| `de` | German | `Intl.Segmenter` — ready today | No gap-fill parser yet (see §4) |
| `ko` | Korean | boundaries OK; agglutination needs review | No gap-fill parser yet |
| `cmn` | Mandarin | `Intl.Segmenter` does **not** do real Chinese segmentation — needs a dedicated (WASM) segmenter, loaded lazily | Planned |
| `tlh` | Klingon (pIqaD) | no open structured dataset; custom affix-aware tokenizer | Curation-only, experimental |

Also pending for non-English books: the English-only contraction/possessive
clitic rules in the tokenizer must be gated by the book's language so they never
fire on e.g. a Spanish book.

## 5. Home library server

Implemented: book store, per-profile vocabulary sync, cross-device
reading-position sync, shared AI-explanation cache (see
[home-server.md](home-server.md)). Still pending from the design:

- **Accounts.** Real users instead of the trusted "profile name": username +
  password (argon2id), signed session tokens, authorization on every protected
  route. Registration is self-service but an account starts `pending`.
- **Admin approval + age gating.** The admin (a parent) approves each pending
  account and confirms its `rating_tier` (defaulted from a declared birthdate).
  Books carry a rating (uploader sets, admin overrides); `GET /books` filters by
  `book.rating ≤ user.rating_tier` **server-side on every request**. This is the
  honest, LAN-proportionate version of "age verification".
- **Shelf ACL (later).** Optional named shelves restricted to specific users
  (private shelf), independent of the age gate. Deliberately coarse.
- **OPDS export (later).** Publish the catalog as an OPDS feed so generic e-reader
  apps can browse/download the library too.
- **Operational polish.** Documented one-command backup (two SQLite files + the
  blob dir), total-storage display, delete-to-free-space, and rate limiting /
  lockout only if the threat model ever grows.

## 6. Word Swiper

- **Images on the card** (2–4 per word) to anchor meaning visually:
  - Keyless, CORS-friendly sources only: **Openverse** or **Wikimedia Commons**
    (keyed services deliberately avoided).
  - The disambiguating query is the key idea: send the word + its **book
    sentence** to the LLM and ask for a 2–3 keyword visual query ("Apple was
    founded…" → "apple computer logo"; "he ate an apple" → "apple fruit").
    Fallback without AI: word + key nouns from the dictionary definition.
  - Lazy-load thumbnails, cache per word, degrade gracefully for abstract words.
- Session settings: deck size cap, include/exclude the most common function
  words, remember skips for the session, show meaning before vs. after deciding.

## 7. Dictionary & Progress hubs

- **Recent activity** view (words moved to Known/Learning in the last 7/30 days)
  and per-week deltas.
- Optional **daily snapshot log** `[{date, known, learning}]` if last-change-only
  growth charts feel coarse; CSV export.
- A bottom-nav slot is reserved for **Practice** once a global (cross-book)
  deck exists — today the swiper is launched per book from the shelf.
- When KB translations/locking land (§4), surface them in the same `dictRow`s
  (translations per sense, pin icon on locked fields).

## 8. Frequency-list seeding (explicitly opt-in, never default)

An optional "mark the N most frequent words as Known" bootstrap for users who
already have a base. The red-sea default (every unseen word starts Unknown) is a
product invariant — this feature must never become automatic.

## 9. Word families — what is left

The lemma layer is built and visible (part-of-speech-aware inflections, curated
closed-class paradigms, the family card in the bubble / popup / Dictionary — see
[home-server.md §2a](home-server.md) and [design.md §6a](design.md)). What it does
not do yet:

- **"Real words" in Progress.** Today the hub counts surface forms: `go`, `goes`,
  `went`, `gone` are four. The honest second metric is *lemmas* — "312 forms · 201
  real words" — with a lemma counted as known only when **every form of it the user
  has actually met** is known (a partial 4/5 is itself the useful signal: it names
  the irregular form still missing). Pronouns group in the card but are never rolled
  into that fraction — I/me/my/mine are five things to learn, not 4/5 of one.
  Needs a bulk `POST /forms` (vocabulary keys → `{lemma, pos, tag}`), cached on the
  client so the metric degrades to forms-only when the server is away.
- **One card per family in the Word Swiper.** The deck already shows the family on
  each card and lets you jump between its forms, but it still *draws* one card per
  surface form. The open question is whether a lemma should instead deal a single
  card ("GO — you know 3 of 5; here are the other 2").
- **Homographs need the sentence.** `wound` resolves to *wind* (past) regardless of
  whether the sentence means an injury; `left` is never linked to *leave*. This is
  the one place the AI genuinely helps: resolve it once per book occurrence with the
  sentence as context (same cascade as sense disambiguation), never per token at
  runtime, and route low-confidence answers to a review queue instead of writing
  them into the KB. The prompt must be scoped to INFLECTION only — a false "singer
  is a form of sing" corrupts the entry a learner reads, so "not sure" must be the
  cheap answer.
- **A gold-standard test set** before any AI is allowed to write to the KB:
  regular/irregular verbs, plurals, degrees, plus the two traps that matter —
  derivation (`singer`, `happiness`, `building`-as-noun must say *not a form*) and
  false affixes (`corner`, `ring`, `under`). Measure per category; iterate the
  prompt, not the architecture.
- **A manual fix in the Dictionary hub.** A wrong grouping should be correctable by
  hand and locked (the same `locked` provenance guard as §4).
- **Spanish.** Verb conjugation is a far larger paradigm (regular -ar/-er/-ir plus a
  sizeable irregular table); the schema already carries `pos` and `lang`, so this is
  a data problem, not a design one.

## 10. Mobile: on-device server & multi-server sync

The Android APK ships as a Capacitor WebView (implemented — see
[android.md](android.md)). The web is the single source of truth; the APK embeds a
build of it and hardens storage. What is still *future* is untethering the phone from
the home LAN for the two things that genuinely need a server: **the AI (Ollama)** and
**centralized history/sync**.

- **A server on the phone itself (Termux).** The home-server is already Node +
  better-sqlite3, which runs under Termux, so the same process could run on the
  device. This is the bridge until phones expose a public on-device AI API: when
  away from home, a local Termux server answers explanation/dictionary requests
  instead of the (unreachable) home machine. Real considerations: `better-sqlite3`
  is a native addon and needs a build toolchain under Termux; the server must be
  startable/stoppable on demand (battery), and small enough models to be usable on
  the phone's CPU (the §1 hardware gate applies here too).
- **Multi-server topology: primary + backup.** With two servers (home = primary,
  Termux = backup/away) the open question is roles and reconciliation. Vocabulary and
  reading-position already sync last-write-wins by timestamp; the KB and the
  AI-explanation cache would need the same treatment so the away-server's answers
  merge back into the home KB on reconnect (and vice-versa) without drift. The home
  server stays authoritative for the library and accounts (§5); the phone server is a
  read-through cache + AI worker, not a second source of truth. Deciding exactly what
  the backup is *allowed* to write is the core design work here.
- **Away-mode UX.** The app should know which server it can currently reach and route
  transparently (home when on-LAN, phone-local when away, offline-degraded when
  neither), surfacing the state without asking the user to flip switches.
