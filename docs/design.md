# The Immersive Reader — Core Design (implemented)

The reading core: ingest a book, color every word by learning state, mark words
while reading, and explain them in context. This documents the system **as
built**; anything not yet built lives only in [vision.md](vision.md).

## 1. Concept

The user loads a real text and reads it in a distraction-free eReader where every
word is color-coded by how well they know it: **Unknown** (vibrant red),
**Learning** (gold/orange), **Known** (blends into the background). A fourth,
opt-in state — **Discarded** (recessive slate-blue) — sets a word *aside* as not
learnable vocabulary of this language (proper nouns, code identifiers, Roman
numerals, stray letters). The default state is **Unknown** — the "red sea" — on
purpose: the page visibly calms down as knowledge grows. State is **never changed
automatically** (Discarded included — it is only ever a deliberate user action, and
is never inferred from a missing dictionary entry).

## 2. Key decisions (all in effect)

| Decision | Choice |
| --- | --- |
| Default word state | **Unknown ("red sea")**; any frequency-list seeding is future and opt-in only |
| Discarded (exempt) | A manual-only 4th state for tokens that aren't learnable vocabulary (proper nouns, code, Roman numerals…): recessive slate-blue, out of the known/learning totals and the study deck, **counts as known for readability**, reversible from the Dictionary hub. Never auto-applied |
| State key | `<lang>:<normalized word>` — one vocabulary **per language**; marking a word recolors every occurrence in that language across all books, while the same spelling in another language stays independent |
| Reading language | **Per book** (asked on add, editable later); a persisted *default* seeds new books; when a book's language equals the user's native language the red sea is suppressed |
| Tokenizer | `Intl.Segmenter` (native), preserving whitespace/punctuation for exact re-render; curly apostrophes normalized to straight |
| Contractions | Decomposed into component lemmas, never a vocabulary entry of their own (see §4) |
| Storage | Vocabulary + definitions cache in `localStorage`; books, content and per-book word lists in IndexedDB; the shared/authoritative copies live on the home server (SQLite) when it is reachable |
| Definitions | Pluggable provider chain (see §6) |
| Stack | Vanilla JS + HTML + CSS, built with Vite; no framework |

## 3. Data flow

```text
File (txt/md/pdf/epub)
   │  ingest + normalize (client-side; pdf.js / fflate)
   ▼
Clean text + anchored images  →  stored in the library (IndexedDB, .tir exportable)
   │  Intl.Segmenter
   ▼
Tokens (word + whitespace/punctuation, preserved)
   │  cross-reference vocabulary store
   ▼
eReader view (each word tagged with its normalized key + state class)
   │  hold/tap (see §5)
   ▼
State change → recolor ALL occurrences in this language → persist → sync to server
   │  lookup
   ▼
Definition chain → popup (quick definition, KB details, AI explanations)
```

## 4. Words, normalization, contractions

`src/normalize.js` is the **single source of truth** for word keys, shared
verbatim by the browser and the Node server (dependency-free on purpose):
lowercase + NFC, curly→straight apostrophes, trim non-letter edges, strip a
trailing possessive `'s` (`Dursley's` → `dursley`). `src/words.js` shares the
segmentation rules the same way (hyphenated compounds split, pure numbers and
standalone possessives drop out, contractions stay whole as surface forms).
URLs and e-mail addresses (`scheme://…`, `www.…`, `user@host.tld`) are detected
before segmentation and kept whole as single non-word tokens — the segmenter
would otherwise shred `http://programmer-avec-ocaml.lri.fr/` into five fake
words. They never enter the vocabulary; in the reader they render as quietly
underlined tappable spans (see the link bubble in §5). Trailing sentence
punctuation stays outside the link; bare domains without a scheme or `www.` are
left as ordinary text.

**Contractions** (`src/contractions.js`) are shorthand for two real words, so
they are never stored or counted as vocabulary. `didn't` maps to `[did, not]`:

- reader color is **derived** from the components — most-urgent state wins;
- marking a contraction applies the chosen state to **all** components;
- stats/decks expand them, never counting a contraction as a unique word.

The registry ships with common English contractions and **grows at runtime**: an
unseen contraction is decomposed in context by Ollama (resolving `'d` →
would/had, `'s` → is/has), then cached and persisted. Genuine possessives are
handled by `normalize()` and are not in the registry. Migrations keep old data
consistent: whole-contraction vocabulary entries are re-mapped to lemmas on
load, and per-book word lists are versioned so stale lists are recomputed.

## 5. Reader & marking interaction

Two reading modes (menu-selectable, re-rendered in place at the current spot):

- **Paged** (`reader/paginator.js`): virtualized — only the current page is in
  the DOM, so huge books don't freeze. Page turns are a **live drag**
  (`reader/pageTurn.js`): the page follows the finger, an adjacent page slides
  in, releasing past ~20% of the width commits; buttons/arrow keys play the same
  slide; a tap in the outer thirds/margins turns Google-Books style.
- **Continuous** (`reader/scroller.js`): windowed scroll that keeps the full
  text available (enables external read-aloud tools).

Marking (`src/marking.js` + `src/gloss.js`) follows one rule — **gestures only
open bubbles; actions are visible buttons inside them** — so a new feature never
becomes another hidden gesture:

- **Single tap on an unknown or learning word** opens its **word bubble**
  (`src/gloss.js`): a speech bubble with a tail pointing at the word, visually
  distinct from the book text. It holds the word (state-colored) with a small
  **legend naming its current state** beside it, part of speech, a 🔊 that
  pronounces the word and then its definition (`src/speech.js`, Web Speech), a
  two-line definition, **three state chips** to mark without opening the popup,
  and `⋯` to expand into the full popup. The chips are always the **three states
  the word is *not* in** (fixed order `Discarded · Unknown · Known · Learning`
  minus the current one) — the current state is the colored word + legend, never a
  redundant button. Contractions gloss instantly
  as their decomposition ("didn't = did + not"). Tapping a **known** or
  **discarded** word does nothing — both are resolved, and fluent reading is never
  interrupted (a deliberate press-and-hold still opens the bubble to reverse a
  wrong discard).
- **Press-and-hold** any word (including known) opens the same bubble, with a
  light counterweight that grows with how well the word is known: unknown
  250 ms (the double-tap window), learning 500 ms, known or discarded 1 s — the
  slower holds show a fill animation. It signals intent without the old heavy
  gate (2 s holds made sense when they guarded the full popup; the bubble is a light
  glance). The full popup only ever opens **from** the bubble.
- **Double tap** opens the **paragraph bubble**: read the paragraph aloud
  (toggle stop), copy the paragraph, copy the word (clipboard with a legacy
  fallback for non-HTTPS LAN contexts, `src/copy.js`). While any read-aloud is
  playing, a fixed **`⏹ Stop reading` pill** shows at the bottom — the playback
  indicator and stop control that survives the bubble's auto-hide.
- **Tap on a link** (a URL/e-mail token, §4) opens the **link bubble**: the
  link's text plus `Open in new tab ↗` (scheme-less `www.` links get `https://`,
  e-mail addresses open as `mailto:`) and `Copy link`. The tap itself never
  navigates — the reader is never navigated away from.
- Both the bubble chips and the full popup's list offer only the **three states
  the word is not in** (the popup also colors the word and shows the same state
  legend); keys `1`/`2`/`3`/`4` set Known / Learning / Unknown / Discarded
  regardless of position. Every occurrence recolors immediately (`reader/render.js`).
- Top/bottom chrome auto-hides and only reveals near the screen edges.

Themes (dark + light variants) via `reader/theme.js`; a selectable reader
typeface (bundled Literata variable font + system stacks) applies through CSS
variables and re-paginates on change.

## 6. Definition layer

Interface: a provider takes `(word, sentence)` and returns
`{ explanation, source }` or `null`; the first answer wins, so sources can
change without touching the UI (`src/definitions/index.js`).

- **Quick chain** (fast, auto-fetched for unknown/learning words):
  `localDict` → **KB** (`kbApi.js`, the home server's offline dictionary; carries
  part of speech, verb tenses, synonyms/antonyms, lemma links) →
  `dictionaryapi.dev` (free, keyless). A raw (un-refined) KB hit triggers a
  background server build so the next lookup is the refined one.
- **AI explanations** (always on demand, per context): brokered and cached by
  the home server (`serverAi.js`) — generated once, shared across devices; the
  "Ask AI" button shows only when the server + Ollama are reachable. Each answer
  is stored per exact sentence and never regenerated (only failed lookups can be
  retried). An on-demand **"Explain in &lt;native language&gt;"** rescue works
  the same way.
- **Web-dictionary links** (`externalLookup.js`): Cambridge/Oxford/etc. links as
  the last resort when nothing else answers.
- **Caching** (`definitionsCache.js`): per `<lang>:<word>` — dictionary result,
  a capped newest-first **history of AI contexts** (the word's usage panorama),
  and native-language answers per sentence.
- State-dependent popup behavior: unknown/learning auto-fetch the quick
  definition; **known** words never auto-fetch (a "Look it up" button shows it on
  demand). The popup never changes a word's state.

## 7. Module map

```text
src/
  ingest/            txt, md, pdf (pdf.js: de-hyphenation, line-wrap repair,
                     paragraphs from geometry), epub (fflate, spine order); → {text, images}
  tokenizer.js       text → Token[] (Intl.Segmenter, whitespace preserved)
  normalize.js       word → key (shared with the server)
  words.js           segmentation shared with the server's book builder
  vocabulary.js      <lang>:<word> → {state, at}; onChange/applyRemoteEntry for sync
  contractions.js    registry, color aggregation, AI-grown entries, migrations
  sentences.js       sentence + paragraph lookup per word index
  reader/            render, paginator, scroller, pageTurn, theme
  marking.js         hold/tap gestures, popup wiring   popup.js  the word popup
  gloss.js           the word/paragraph speech bubble
  speech.js          Web Speech: word, word+definition, paragraph read-aloud
                     (user-set voice + speed; sentence-chunked; a settle delay
                     after cancel avoids the engines' first-words clipping)
  definitions/       index (chain), localDict, kbApi, dictionaryApi, serverAi,
                     ollama (contraction decomposition only), prompts
  definitionsCache.js  per-language word cache (dict + AI history + native)
  library.js/shelf.js/tir.js        local library, shelf UI, .tir format  → docs/library.md
  serverLibrary.js/serverShelf.js   server catalog + Server hub           → docs/home-server.md
  vocabSync.js                      offline-first vocabulary sync         → docs/home-server.md
  dashboard.js/stats.js/charts.js/kbDetails.js  Dictionary & Progress hubs → docs/dictionary-progress.md
  deck.js/swiper.js                 Word Swiper                           → docs/word-swiper.md
  settings.js        native language, default reading language, active (per-book)
                     reading language, home-server URL, profile, AI model,
                     reading mode/font, read-aloud voice + speed, shelf sort
  main.js            view switching (shelf | server | dictionary | progress |
                     reader | swiper) and wiring
```
