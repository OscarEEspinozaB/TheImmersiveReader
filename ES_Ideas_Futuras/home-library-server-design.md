# The Immersive Reader — Home Library Server (Analysis & Design)

> Status: **In progress (Phase 2).** Drafted 2026-06-28. **Milestone 2 (book store +
> upload/download, no accounts yet) is implemented** as of 2026-06-29: `/books`
> routes in the existing server process ([server/routes/books.js](../server/routes/books.js),
> [server/library-db.js](../server/library-db.js)), client in
> [src/serverLibrary.js](../src/serverLibrary.js) + [src/serverShelf.js](../src/serverShelf.js)
> (upload from the shelf's ☁ button; a "Server" hub view to browse and download). The
> `.tir` is the wire format. Accounts (M1), vocab/progress sync (M3), shared KB (M4)
> and age gating (M5) remain. This is the client/server split anticipated in
> [CLAUDE.md](../CLAUDE.md) ("Phase 2") and the "cloud sync" non-goal of
> [docs/library-design.md](../docs/library-design.md), now promoted to a goal.

## 1. Goal

Turn the single-device app into a **home digital-library server**: one machine on the
home LAN holds the books, the user accounts, and the learning data; every device
(laptop, phone) connects to upload books to the shelf, download them to read offline,
and keep its **vocabulary and reading progress in sync**.

Crucially, this is **not just a file server**. The product is a tool for **reading in a
language that is not your mother tongue and tracking which words you already know in
that language**. So the server's first-class data is not the books — it is the
**per-user, per-learning-language vocabulary** and the **shared dictionary** that grows
as people read. The library (storage, accounts, age gating, upload/download) is the
commodity layer around that core.

### Decisions taken (2026-06-28)

| Question | Decision | Consequence |
| --- | --- | --- |
| Build vs. integrate | **Own server**, built on our own dictionary KB + book model + user model | Full control; the unique immersion data is native to the schema, not bolted on |
| Network reach | **Home LAN only** | Minimal threat model; no internet exposure, no public TLS/CA, light auth |
| Content restriction | **Self-service registration with verification** | Users sign up themselves; an admin (parent) approves and confirms each account's age tier |

## 2. Prior art (why we are not reinventing the *storage* layer's ideas)

"Plex/Jellyfin for books" already exists and is mature: **Kavita** (ebooks/comics,
per-account age ratings), **Calibre-Web** (ebooks, per-user tag permissions),
**Komga**, **Audiobookshelf**, the **Calibre content server**. The catalog interchange
standard between a server and any reader is **OPDS** (an RSS-like feed of book
entries). Accounts, upload/download and **per-user age restriction are solved problems**
there — Kavita filters the catalog by each account's maximum rating out of the box.

We deliberately build our own server anyway, because our differentiator (per-word
vocabulary state + contextual dictionary + LLM refinement, all per learning language)
has to be native to the data model — none of those servers store it. But we **borrow
their proven patterns** (rating-gated catalog, OPDS-shaped browse/download) instead of
inventing new ones, and we **keep OPDS export as a later milestone** so generic readers
can still consume our library.

## 3. Architecture

```text
        Home LAN (no internet exposure)
 ┌──────────────┐        ┌──────────────┐        ┌─────────────────────────┐
 │  Laptop      │        │  Phone       │        │  Home server (1 box)     │
 │  TIR client  │  HTTP  │  TIR client  │  HTTP  │  ┌────────────────────┐  │
 │  (PWA)       │◄──────►│  (PWA)       │◄──────►│  │ TIR API (Node/TS)  │  │
 │  IndexedDB   │  /LAN  │  IndexedDB   │  /LAN  │  │  auth · books ·    │  │
 │  cache       │        │  cache       │        │  │  vocab · progress ·│  │
 └──────────────┘        └──────────────┘        │  │  dictionary KB     │  │
                                                 │  └─────────┬──────────┘  │
                                                 │     SQLite │  files/     │
                                                 │            │  blobs      │
                                                 │     ┌──────┴───────┐     │
                                                 │     │ Ollama (opt.)│     │
                                                 │     └──────────────┘     │
                                                 └─────────────────────────┘
```

- **Client = the current app, unchanged in spirit.** It stays an offline-first PWA. Its
  IndexedDB ([src/library.js](../src/library.js)) becomes a **local cache/mirror** of
  the server, so reading works with no connection and syncs when back on the LAN.
- **Ingestion stays on the client.** A PDF/EPUB is extracted and tokenized exactly as
  today; the client uploads the **already-processed book** (the planned `.tir` payload —
  clean text + anchored images), never the raw source. This keeps the server thin and
  format-agnostic, and reuses the `.tir` format from
  [docs/library-design.md](../docs/library-design.md) §5 as the **wire format**.
- **Server = thin authority** for accounts, the book store, age gating, and — the part
  that matters — the **sync of vocabulary, progress and the shared dictionary**.

### 3a. Server stack — recommendation: Node/TypeScript + SQLite

[CLAUDE.md](../CLAUDE.md) pencils Phase 2 as Rust + PostgreSQL. For a **home-LAN, single
box** this design recommends **Node/TypeScript + SQLite (better-sqlite3)** instead, and
states the trade-off honestly:

- **Code reuse is decisive.** The entire ingest/tokenize/normalize/contraction stack is
  already JavaScript (pdf.js, fflate, `tokenizer.js`, `normalize.js`,
  `contractions.js`). If any of it ever needs to run server-side, Node reuses it
  verbatim; Rust would re-implement pdf.js-grade extraction.
- **SQLite, not Postgres.** One household, a handful of users — SQLite is a single file,
  zero-ops, trivially backed up, and matches the project's "no server cost / fast
  iteration" ethos. Postgres only earns its keep at multi-tenant scale we explicitly do
  not have on a home LAN.
- **When to revisit Rust/Postgres:** if this ever leaves the LAN for the public internet
  or grows past one family. Not now.

## 4. Data model (SQLite)

```text
users
  id            uuid pk
  username      text unique
  password_hash text                 -- argon2id
  native_lang   text                 -- e.g. "es"; never red-seaed, never tracked
  birthdate     date                 -- declared at signup; drives age tier
  rating_tier   text                 -- confirmed allowed maximum: all|teen|mature|adult
  role          text                 -- admin | member
  status        text                 -- pending | active | disabled
  created_at    int

books
  id            uuid pk
  title         text
  author        text
  lang          text                 -- the book's READING language (learning lang)
  rating        text                 -- all|teen|mature|adult  (uploader sets, admin can override)
  uploader_id   uuid fk users
  added_at      int
  cover_path    text                 -- thumbnail file
  payload_path  text                 -- the stored .tir (clean text + images)
  -- visibility handled by rating gate + optional shelf ACL (§6)

reading_progress                     -- per user, per book (was per-book only, now per-user)
  user_id       uuid fk
  book_id       uuid fk
  word_index    int
  updated_at    int
  pk (user_id, book_id)

vocabulary                           -- THE core table: known words per learning language
  user_id       uuid fk
  lang          text                 -- learning language, scopes the word
  word          text                 -- normalized (lowercased, punctuation stripped)
  state         text                 -- unknown | learning | known  (unknown not stored)
  updated_at    int                  -- for last-write-wins sync
  pk (user_id, lang, word)

dictionary                           -- SHARED knowledge base, grows for everyone
  lang          text
  word          text
  payload       json                 -- senses, translations, synonyms, AI-refined fields
  source        text                 -- local | api | ai
  model         text                 -- which model refined it (for re-refine)
  updated_at    int
  pk (lang, word)
```

Why this shape:

- **Vocabulary and progress are now per `user_id`**, not global on a device. This is the
  whole reason for the server: my "known words in English" follow me from laptop to
  phone. The `(user_id, lang, word)` key preserves the product invariant — **the same
  spelling in two languages stays independent, and the native language is never tracked**.
- **The dictionary is shared, keyed only by `(lang, word)`** — not per user. A definition
  is reference content; one reader refining *wand* benefits everyone. This makes the
  server worth running even for a single user across devices, and far more valuable for a
  family: the red sea fades faster because the KB grows communally. (Mirrors the per-`<lang>:<word>`
  keying already in [src/definitionsCache.js](../src/definitionsCache.js).)

## 5. Accounts, age verification & the threat model

Self-service registration, but **proportional to "a box on the home WiFi"** — not a
public SaaS.

- **Sign up:** username + password + `native_lang` + `birthdate`. Account is created
  `status = pending`.
- **Verification = admin approval.** In a home, the admin (parent/owner) *knows* the real
  ages, so "verification" is the admin approving the pending account and confirming its
  `rating_tier` (defaulting from `birthdate`). This reconciles "self-service" (users
  register themselves, set their own languages, no manual provisioning) with a household
  (a grown-up gates what the kids' accounts can reach). No email/SMS/ID flow needed on a
  LAN.
- **Age gate on every catalog read:** `GET /books` returns only rows where
  `book.rating <= user.rating_tier` (plus any shelf ACL). The gate is enforced
  **server-side on every request**, never by hiding things in the client.
- **Book rating source:** the uploader picks a rating at upload; an admin can override.
  No automated content rating.

Threat model (LAN-only):

- In scope: a curious kid trying to reach an adult book; a second household device; basic
  credential hygiene.
- **Out of scope:** internet attackers, because nothing is exposed. The server binds to
  the LAN interface only.
- Still do the cheap, correct things: **argon2id** password hashing, signed session
  tokens (HTTP-only cookie or bearer), authorization checks on every protected route,
  and an **optional self-signed TLS** cert for the LAN (or plain HTTP on a trusted home
  network). Rate limiting and account lockout are nice-to-have, not load-bearing here.

## 6. Visibility / restricted documents

Two independent mechanisms, kept simple:

1. **Age rating** (primary): the `book.rating ≤ user.rating_tier` gate above. Covers
   "this document is not for the kids' accounts."
2. **Shelf ACL** (optional, later): a book may belong to a named shelf, and a shelf may be
   restricted to specific `user_id`s (e.g. a private/personal shelf). Default: no ACL,
   visible to anyone who passes the age gate.

This deliberately stays coarse — a home, not an enterprise. Tag-level per-user permissions
(à la Calibre-Web) are a later refinement if ever needed.

## 7. Sync model (offline-first)

The client never blocks on the network. It reads and writes its IndexedDB cache, then
reconciles with the server.

- **Vocabulary & progress:** per-row **last-write-wins by `updated_at`**. A `PATCH` carries
  `{lang, word, state, updated_at}`; the server keeps the newest. A periodic/`on-focus`
  `GET /vocab?lang=&since=<ts>` pulls peers' changes. This is enough for one person on two
  devices and for a family where collisions on the same `(user, lang, word)` are rare.
- **Books:** content is immutable once uploaded, so sync is trivial — list, then download
  any `.tir` not yet cached. Deletes propagate as tombstones.
- **Dictionary KB:** shared and effectively append/refine-only; pull `since` a timestamp.
  A stronger-model re-refine (already a feature, see
  [git log: "allow re-refine with a stronger model"]) updates the shared row and fans out
  on next pull.

## 8. API surface (REST over the LAN)

```text
POST   /auth/register        {username, password, nativeLang, birthdate} -> pending account
POST   /auth/login           {username, password} -> session token
GET    /auth/me

GET    /books?lang=&q=        -> catalog, AGE/ACL filtered server-side
POST   /books                 -> upload .tir + metadata (multipart)   [member]
GET    /books/:id             -> metadata
GET    /books/:id/content     -> the .tir payload (download to cache)
GET    /books/:id/cover

GET    /progress             ?since=        PUT /progress/:bookId
GET    /vocab     ?lang=     &since=        PATCH /vocab            (single word)
                                            PUT   /vocab           (bulk reconcile)
GET    /dictionary/:lang/:word              PUT  /dictionary/:lang/:word   (refine)

# admin
GET    /admin/users          PATCH /admin/users/:id   (approve / set tier / disable)
PATCH  /admin/books/:id      (override rating, shelf/ACL)
```

## 9. How it maps onto the existing code

| Today (client-only) | Becomes |
| --- | --- |
| [src/library.js](../src/library.js) IndexedDB books store | **Local cache/mirror** of the server catalog; download = ingest-once still applies |
| `.tir` export/import ([docs/library-design.md](../docs/library-design.md) §5) | The **upload/download wire format** — built once, reused |
| [src/vocabulary.js](../src/vocabulary.js) `<lang>:<word>` store | Gains a **sync layer** to the `vocabulary` table; semantics unchanged |
| [src/definitionsCache.js](../src/definitionsCache.js) | Backed by the **shared `dictionary`** table; local cache in front |
| [src/settings.js](../src/settings.js) active reading lang | Unchanged — still per-book, client-side |
| Per-book `progressWordIndex` | Moves to **per-user** `reading_progress` |
| Vite dev server ([ES_Ideas_Futuras/web-server-setup-ES.md](web-server-setup-ES.md)) | Still serves the **static client**; the new API is a sibling process |

The client stays a static PWA served as today; the API is a separate Node process on the
same box. Nothing about the reading/coloring/marking UI changes.

## 10. Milestones

1. **Thin server + accounts.** Node/TS + SQLite, `/auth`, single admin, `users` table,
   argon2id, session tokens. Bind to LAN only.
2. **Book store + download/upload.** ✅ Done (no accounts yet). `/books`, store `.tir`,
   client browses the catalog and downloads into its existing local library. (Library
   now has two sources: local import + server.) Uploads are deduped by sha256;
   metadata is read from the `.tir` manifest server-side; books are immutable.
3. **The core sync.** ✅ Vocabulary sync done (no accounts yet — a lightweight
   profile name identifies the user). `vocabulary` table + `/vocab`
   (GET since / PUT bulk / PATCH) in [server/routes/vocab.js](../server/routes/vocab.js);
   client outbox + pull/merge in [src/vocabSync.js](../src/vocabSync.js), wired through
   [src/vocabulary.js](../src/vocabulary.js) (`onChange` / `applyRemoteEntry`). Offline-first,
   last-write-wins by timestamp; a wiped browser is restored from the server on next load.
   `reading_progress` sync is still pending.
4. **Shared dictionary KB** on the server; client cache in front; re-refine fans out.
5. **Self-service registration + admin approval + age gating.** `birthdate` → `rating_tier`,
   per-request catalog filter, book ratings, admin approval queue.
6. **Polish:** covers, search, shelf ACL, backups (copy one SQLite file + the blob dir),
   and **OPDS export** so generic readers can also consume the library.

## 11. Open questions / risks

- **Vocab conflict resolution:** last-write-wins is fine for one user/many devices; if two
  family members genuinely shared one account it could clobber — but vocab is per `user_id`,
  so they wouldn't. Accept LWW.
- **Who rates a book?** Uploader picks, admin overrides. No automation. Good enough at home.
- **"Verification" realism on a LAN:** admin approval is the honest interpretation; revisit
  only if this ever leaves the house (then it becomes the Rust/Postgres, internet-exposed
  rewrite, with real verification).
- **Storage growth:** illustrated books are large; show total usage and allow deletes
  (already an open question in [docs/library-design.md](../docs/library-design.md) §9), now
  server-side.
- **Backups:** document a one-command backup (SQLite file + blobs) before this holds the
  only copy of someone's vocabulary.
```

