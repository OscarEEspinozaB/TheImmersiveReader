# The Immersive Reader — Dictionary Knowledge Base (Implementation Plan)

> Status: **Proposed (implementation plan).** Last updated 2026-06-25.
>
> This is the *how* for [dictionary-knowledge-base-design.md](dictionary-knowledge-base-design.md)
> (the *what/why*). It maps every part of that design onto concrete modules, function
> signatures, IndexedDB changes, and a milestone order that keeps the app shippable at
> every step. Nothing here changes word state; the KB is purely *information about*
> words (see the design's invariant).

## 0. How this grounds onto the current codebase

The design already fits the code we have. Concretely:

| Design concept | Already exists | Where |
| --- | --- | --- |
| Unique-word collection per book | `uniqueWords(text)` | [src/deck.js](../src/deck.js#L25) |
| Lemma model (contractions → parts, numbers ignored) | `lemmasOf` | [src/deck.js](../src/deck.js#L17) |
| Normalized word key | `normalize()` | [src/vocabulary.js](../src/vocabulary.js) |
| On-demand provider chain (the fallback the KB keeps) | `getQuickDefinition`, provider chain | [src/definitions/index.js](../src/definitions/index.js) |
| Per-word definition cache | `definitionsCache.js` | [src/definitionsCache.js](../src/definitionsCache.js) |
| IndexedDB helper + versioned stores | `idb.js` (DB `immersive-reader`, v3) | [src/idb.js](../src/idb.js) |
| Per-book word lists already persisted | `bookwords` store | [src/library.js](../src/library.js) |

So the implementation is mostly **new stores + a worker + a read path**, not a rewrite.
Three things must NOT be touched in role: `vocabulary.js` (state), `definitionsCache.js`
(on-demand fallback cache), and the existing provider chain.

## 1. Book language (the source language) — chosen per book

The KB is multi-language and the library holds many books, so the **source language**
— the language a book is written in, which the user is learning — **must live on the
book, not in a global setting**. Today it is a single global `readingLang` in
[settings.js](../src/settings.js#L29); that becomes ambiguous the moment the library
mixes an English novel and a Spanish one (which `lang` do we tokenize / key / look up
under?). This is the prerequisite that lets a book "understand its own base dictionary".

**Decision (confirmed): the language is chosen manually at import** — a required
selector in the import dialog, options from `READING_LANGUAGES`
([settings.js](../src/settings.js#L12)). No auto-detection, no new dependency. The
global `readingLang` becomes only the *pre-selected default* in that selector.

### 1.1 Data model

- `BookMeta` ([library.js](../src/library.js#L12)) gains `lang: string` (ISO code,
  e.g. `'en'`); `addBook({ title, text, ..., lang })` stores it.
- Migration: existing books have no `lang`. On load, backfill to the current global
  `readingLang` (default `'en'`); the value stays editable from book details later.
  (Same versioned-backfill pattern already used for `bookwords`.)

### 1.2 Everything language-dependent reads `book.lang`, not the global

- **Tokenizer**: `tokenize(text)` currently calls `getReadingLang()` directly
  ([tokenizer.js](../src/tokenizer.js#L31)). Make it
  `tokenize(text, lang = getReadingLang())` and thread the open book's `lang` from
  `main.js`. This also gates the **English-only contraction/possessive clitic rules**
  ([tokenizer.js](../src/tokenizer.js#L21)) — they must not fire on a Spanish or
  Chinese book.
- **KB keys**: entries are `${book.lang}:${word}`. The generation worker iterates books
  and keys each book's words under *that book's* lang — so one library batch can
  populate `en:*` and `es:*` correctly in a single run.
- **Prompts**: `getReadingLangName()` ([prompts.js](../src/definitions/prompts.js#L38))
  derives from the open book's lang.
- **Read path**: the popup looks up `getEntry(book.lang, normalize(word))`.
- **Native language stays global**: `settings.language` ('Spanish') is the *user's*
  language and drives `translations[]` per sense — it is per-user, never per-book.

### 1.3 Two language axes, kept separate

| Axis | Scope | Drives | Where |
| --- | --- | --- | --- |
| **Source / book language** | per **book** (`BookMeta.lang`) | tokenizer, offline dataset, KB `lang` key, definition language | new field |
| **Native language** | per **user** (global) | per-sense `translations[]`, on-demand rescue | `settings.language` |

## 2. IndexedDB changes (`src/idb.js`)

The DB is `immersive-reader`, currently `DB_VERSION = 3` with stores
`['kv', 'books', 'content', 'bookwords']`. Bump to **v4** and add two stores:

```js
const DB_VERSION = 4;
const STORES = ['kv', 'books', 'content', 'bookwords', 'dictionaryKB', 'generationProgress'];
```

`dictionaryKB` is keyed by `id` of the form `${lang}:${word}`. The current helpers
(`idbGet/idbGetAll/idbSet/idbDelete`) use out-of-line keys (`put(value, key)`), which
works, but the KB needs a **`byLang` index** for "list all `en` entries" without
scanning every language. That requires either:

- **Option A (minimal):** keep out-of-line keys, store `lang` in the value, and filter
  `idbGetAll('dictionaryKB')` in memory. Fine up to a few tens of thousands of rows
  (the design's stated scale → a few MB). Ship this first.
- **Option B (later):** give `dictionaryKB` an inline `keyPath: 'id'` and a real
  `index('byLang', 'lang')`. Needs a small `createObjectStore` branch in
  `onupgradeneeded`. Do this only if profiling shows the in-memory filter hurts.

Recommendation: **ship Option A**, leave a `// TODO: byLang index (Option B)` note.
A new `kbdb.js` wrapper (below) hides which option is in force so the read path never
changes.

## 3. New module: `src/dictionaryKB.js` (the read/write API)

A thin façade over the `dictionaryKB` store, so the worker, the dashboard, and the
swiper all go through one place. Mirror the shape of `definitionsCache.js`.

```js
// src/dictionaryKB.js
import { idbGet, idbSet, idbGetAll, idbDelete } from './idb.js';

export const KB_SCHEMA_VERSION = 1;
const STORE = 'dictionaryKB';

export const kbId = (lang, word) => `${lang}:${word}`;

/** @returns {Promise<DictionaryEntry|null>} */
export async function getEntry(lang, word) {
  return (await idbGet(STORE, kbId(lang, word))) || null;
}

/** Write-through commit of one entry (used by the generator and by manual edits). */
export async function putEntry(entry) {
  entry.schemaVersion = KB_SCHEMA_VERSION;
  await idbSet(STORE, entry.id, entry);
}

/** All entries for a language (Option A: in-memory filter). */
export async function listByLang(lang) {
  const all = await idbGetAll(STORE);
  return all.filter((e) => e.lang === lang);
}

/** Set a single field + stamp provenance; manual edits lock the field forever. */
export async function setField(lang, word, fieldPath, value, prov) {
  const entry = (await getEntry(lang, word)) || newEntry(lang, word);
  setDeep(entry, fieldPath, value);
  entry.provenance[fieldPath] = {
    source: prov.source, sourceName: prov.sourceName,
    generatedAt: Date.now(),
    locked: prov.source === 'manual' ? true : entry.provenance[fieldPath]?.locked || false,
  };
  await putEntry(entry);
  return entry;
}
```

`DictionaryEntry` is exactly the design's §5.1 shape. `newEntry`, `setDeep`, and the
JSDoc typedefs live here too. **This module is the single import surface** the rest of
the app uses — nobody else talks to the `dictionaryKB` store directly.

## 4. The generation worker: `src/kb/generateWorker.js`

A real Web Worker (the design's §7.3 hard requirement — a full-library batch against
Ollama is multi-hour and must never block the main thread). Vite supports
`new Worker(new URL('./kb/generateWorker.js', import.meta.url), { type: 'module' })`.

Pipeline inside the worker, per the design §7:

1. **Collect vocabulary.** Reuse `uniqueWords(text)` over each book's content
   (`getBookContent`), union into one `Set`. Numbers/contraction-parts handling is
   already correct in `lemmasOf` — do not reimplement it.
2. **Source cascade per word** (sequential, never parallel against Ollama):
   - offline dataset (if a dump is loaded) → `dictionaryapi.dev` → Ollama.
   - The Ollama and dictionary-API call code already exists in `src/definitions/`;
     factor the bare fetch out so the worker can import it without the UI glue, OR
     have the worker `postMessage` lookups back to the main thread if importing
     `ollama.js` into the worker is awkward (it does plain `fetch`, so it should import
     cleanly — prefer the direct import).
   - Stamp `provenance[fieldPath]` with whichever source actually answered.
3. **Write-through:** `await putEntry(entry)` immediately after each word, so a
   still-running batch already benefits the reader.
4. **Resumable:** after every N words (e.g. 25, matching `DICT_CHUNK`), write
   `generationProgress` `{ lang, cursor, total, done, startedAt, status }`. On (re)start,
   read it and skip already-present ids (`getEntry` hit → skip).
5. **Messages:** worker → main `{ type: 'progress', done, total }` to drive a progress
   bar; `{ type: 'done' }`; `{ type: 'error', word, message }`.

A small main-thread controller `src/kb/generation.js` owns the worker lifecycle
(start/pause/resume/cancel) and exposes progress to the dashboard.

### Sense disambiguation source sentence

The design wants `senses[].exampleSentence` pulled from the actual book. We already
build sentence lookups: `buildSentenceLookup(text, tokens)` in [src/sentences.js](../src/sentences.js),
used by `buildDeck`. The worker can reuse it to attach a real example sentence (and
`sourceBook`) to the sense it asks Ollama to disambiguate — no new extraction logic.

## 5. Provenance & locking (design §5.2, §8)

Implemented entirely inside `dictionaryKB.setField` (above):

- Any UI edit calls `setField(..., { source: 'manual' })` → sets `locked: true`,
  permanently.
- A **re-refine pass** is just the generation worker run in `mode: 'refine'`: for each
  existing entry, regenerate only fields where
  `provenance[path].source === 'ai' && !provenance[path].locked`, replacing
  `sourceName`/`generatedAt`, never a locked field.
- `KB_SCHEMA_VERSION` on every entry → batch migration on load, the same pattern
  `vocabulary.js` already uses for its `{state, at}` migration (§5 of the dashboard doc).

## 6. Portable package `.tirdict` (design §6.2)

Mirror the `.tir` book-package pattern (`library-design.md`). `fflate` is already the
project's zip dependency (used by the EPUB ingester).

- **Export** `src/kb/tirdict.js#exportLang(lang)`: stream `listByLang(lang)` to
  `entries.ndjson` (one `JSON.stringify(entry)` per line) + a `manifest.json`
  (`{ format: 'tirdict', lang, schemaVersion, wordCount, generatorModel, builtAt }`),
  zip with fflate, trigger a download `en.tirdict`.
- **Import** `importTirdict(file, { merge })`: unzip, read `entries.ndjson` line by line,
  `putEntry` each. If `merge` (design open-question §12): for an existing id, fill gaps
  and update only **unlocked** fields; never clobber locked ones. If not merge: replace
  wholesale for that language.
- Never load the whole ndjson into memory — read incrementally (matters at 20k+ rows).

One file per language so sharing/updating one language doesn't touch the others.

## 7. Read path / consumption (design §4, §10)

Zero network for any word in the KB. Three consumers, all read-only:

- **Reader popup** ([src/popup.js](../src/popup.js)): before hitting the provider chain,
  try `getEntry(activeLang, normalize(word))`. On hit, render synonyms/antonyms/
  per-sense translations from the KB. On miss, fall through to the **unchanged**
  on-demand chain. This is the one behavioral change users feel: instant, offline defs.
- **Dictionary tab** ([src/dashboard.js](../src/dashboard.js)): see the companion doc
  [dictionary-ui-redesign.md](dictionary-ui-redesign.md). Surface KB fields and a pin
  icon on locked fields; add a language selector.
- **Word Swiper** ([src/swiper.js](../src/swiper.js), `deck.js`): optionally read a KB
  entry's `senses[].exampleSentence` instead of re-deriving — purely additive.

`activeLang` defaults to `en`; the language registry (§5.3 of the design) is a small
static table in a new `src/kb/languages.js` (`LanguageAdapter[]`). English is the only
`active` adapter at first.

## 8. Milestone order (shippable at every step)

Maps the design's §11 onto PR-sized steps:

0. **Book language (§1).** Add `BookMeta.lang`, a required language selector in the
   import dialog (default = global `readingLang`), backfill existing books, and thread
   `book.lang` into `tokenize`. Prerequisite for keying the KB correctly; tiny and
   independently shippable.
1. **Stores + façade.** `idb.js` → v4 + two stores; `dictionaryKB.js` with
   get/put/listByLang/setField + typedefs. No UI yet. (Pure plumbing, no user-visible
   change — safe to land first.)
2. **English batch generator.** `kb/generateWorker.js` + `kb/generation.js`
   (offline-dataset-optional → dictionaryapi.dev → Ollama), write-through, resumable
   via `generationProgress`. A dev-only "Generate KB" button to drive it.
3. **Read path in the popup.** KB hit → offline render; miss → existing chain. This is
   when the feature starts paying off.
4. **`.tirdict` export/import** (fflate, streamed ndjson, optional merge).
5. **Provenance + locking + re-refine** action (worker `mode: 'refine'`).
6. **Spanish adapter** (`es`): per-sense translations via Ollama; language selector
   becomes meaningful.
7. **Korean + Mandarin** (tokenizer work — `Intl.Segmenter` is not enough for Chinese;
   load a WASM segmenter lazily per adapter). **Klingon** stays curation-only.

Steps 1–3 deliver the core promise (offline complete dictionary for English). 4–7 are
independently valuable and can be reordered by what the user wants next.

## 9. Risks / decisions to confirm (design §12)

- **Dataset shipping:** bundle WordNet/Wiktextract dumps in the repo (heavy) vs.
  drag-and-drop once and parse locally. **Recommendation:** drag-and-drop + parse into
  the KB on a worker; keeps the repo light and matches the "owned locally" goal.
- **`byLang` index:** Option A (in-memory filter) first; promote to a real index only
  if profiling demands it.
- **Re-refine granularity:** start with per-language; add per-word/per-sense selection
  later if the all-or-nothing pass feels too blunt.
- **Worker import of `ollama.js`:** confirm it imports cleanly into a module worker
  (it's plain `fetch`, so it should). If a UI-only import sneaks in, factor the bare
  request out into `definitions/ollama.js` first.

## 10. Out of scope (unchanged from the design's non-goals)

No live MT service, no SQL server, no promise of completeness per language. The KB
augments; the on-demand provider chain remains the safety net for anything not yet
generated.
