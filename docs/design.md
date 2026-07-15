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
  text available (enables external read-aloud tools). Only chunks near the viewport
  are in the DOM; the rest are spacers of an estimated height. When a chunk **above**
  the viewport renders to its real height, the scroller compensates `scrollTop` by the
  difference (native `overflow-anchor` is turned off) so the visible text — and a
  just-restored reading position — never drifts as the window fills in. Its programmatic
  scrolls are forced instant (`scroll-behavior: auto`), since the stylesheet's smooth
  scrolling would animate them and race those measurements.

Both modes report their spot as a **word index**; the reader stores it as a
**paragraph-anchored position** (`reader/position.js`) — a paragraph index plus the
Nth word inside it. The paragraph index comes straight from the raw text, so it is
identical on every device and screen size, which is what lets a book resume where
you left off after switching devices (synced through the home server, keyed by book
title — see [home-server.md](home-server.md) §4a). Books saved before this stored a
bare word index; it is converted to a position the first time they are opened.

Marking (`src/marking.js` + `src/gloss.js`) follows one rule — **gestures only
open bubbles; actions are visible buttons inside them** — so a new feature never
becomes another hidden gesture:

- **Single tap on an unknown or learning word** opens its **word bubble**
  (`src/gloss.js`): a speech bubble with a tail pointing at the word, visually
  distinct from the book text. It holds the word (state-colored) with a small
  **legend naming its current state** beside it, part of speech, a 🔊 that
  pronounces the word and then its definition (`src/speech.js`, Web Speech), a
  two-line definition, **the word's family** (§6a — the paradigm, each form in the
  color of the state IT has), **three state chips** to mark without opening the
  popup, and `⋯` to expand into the full popup. The chips are always the **three states
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
  part of speech, the word's family, synonyms/antonyms, lemma links) →
  `dictionaryapi.dev` (free, keyless). A raw (un-refined) KB hit triggers a
  background server build so the next lookup is the refined one.
- **AI explanations** (always on demand, per context): brokered and cached by
  the home server (`serverAi.js`) — generated once, shared across devices; the
  "Ask AI" button shows only when the server + Ollama are reachable. Each answer
  is stored per exact sentence; a failed lookup can be retried, and a **↻
  regenerate** button re-does an answer that came out wrong (below).
  An on-demand **"Explain in &lt;native language&gt;"** rescue works the same way.
- **Regenerate (↻)** in the full popup: when an AI answer is weak, one press re-does
  it in place. Three of them — one on the refined **dictionary** definition (re-runs
  the KB refinement, resolved to the lemma), one on the reading-language **AI
  explanation**, and one on the **native-language explanation** (each forces a fresh
  generation, overwriting the server's shared cache for that sentence so every device
  gets the better answer). Only AI-produced answers carry the button; a raw or online
  definition is not the AI's to redo. The same ↻ lives on each refined row in the
  Dictionary hub.
- **Web-dictionary links** (`externalLookup.js`): Cambridge/Oxford/etc. links as
  the last resort when nothing else answers.
- **Caching** (`definitionsCache.js`): per `<lang>:<word>` — dictionary result,
  a capped newest-first **history of AI contexts** (the word's usage panorama),
  and native-language answers per sentence.
- State-dependent popup behavior: unknown/learning auto-fetch the quick
  definition; **known** words never auto-fetch (a "Look it up" button shows it on
  demand). The popup never changes a word's state.

### 6a. Word families

A word is never shown as a loose word when the KB knows what it is a form of.
`/define` returns the token's **family** — its lemma, how this word relates to it,
and every form the lemma inflects into — and `kbDetails.js` renders it:

- In the **bubble**, a compact strip: `go · went · gone · going · goes`, each form
  painted with the state *it* has, the current one outlined. Seeing a white `go`
  next to a red `gone` is the point: the learner reads the relationship instead of
  five unrelated words.
- In the **popup and the Dictionary hub**, the full card: a banner naming the link
  ("Past tense of **go** · verb"), the paradigm with each form's grammatical tag,
  and a score — *1 of 5 forms known*.
- **Where there is somewhere to go, a form is a button.** In the Dictionary hub it
  filters to that word, scrolls to it and flashes its row (a form the user has never
  marked has no row — the red sea stores no entry for it — so it arrives as the
  "look it up" card, which is the right destination for it). In the Word Swiper it
  jumps the deck to that form's card. A form the destination cannot reach stays a
  plain chip rather than a button that lies. Navigating never marks.

Three rules keep it honest:

- **It shows; it never marks.** Each form is still met and marked on its own — the
  red sea is untouched, and knowing `go` says nothing about `went`. The forms in
  the card are not buttons.
- **The meaning belongs to the lemma.** Looking up `aimed` shows aim's definition
  under the banner (see [home-server.md §2b](home-server.md)); only the word's STATE
  is per surface form.
- **A form is not counted twice.** `walked` is the past *and* the past participle
  of walk: one chip, two tags, one word to learn. `sheep` comes back as a single
  chip tagged *base · plural*, which is exactly the lesson.
- **Pronouns group but are never scored.** `I/me/my/mine/myself` show as one
  family (they are one system of cases), but no fraction is offered: for a learner
  they are five things to learn, not "4/5 of one word".

The data behind it (part-of-speech-aware inflections, curated closed-class
paradigms) is the server's — see [home-server.md §2a](home-server.md).

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
  reader/            render, paginator, scroller, pageTurn, theme,
                     position.js (word index ↔ paragraph-anchored reading position)
  marking.js         hold/tap gestures, popup wiring   popup.js  the word popup
  gloss.js           the word/paragraph speech bubble (incl. the family strip)
  speech.js          Web Speech: word, word+definition, paragraph read-aloud
                     (user-set voice + speed; sentence-chunked; a settle delay
                     after cancel avoids the engines' first-words clipping)
  definitions/       index (chain), localDict, kbApi, dictionaryApi, serverAi,
                     ollama (contraction decomposition only), prompts
  definitionsCache.js  per-language word cache (dict + AI history + native)
  library.js/shelf.js/tir.js        local library, shelf UI, .tir format  → docs/library.md
  serverLibrary.js/serverShelf.js   server catalog + Server hub           → docs/home-server.md
  vocabSync.js                      offline-first vocabulary sync         → docs/home-server.md
  positionSync.js                   cross-device reading position (by title) → docs/home-server.md
  kbDetails.js       KB detail rendering: the family card, POS, synonyms/antonyms
  dashboard.js/stats.js/charts.js  Dictionary & Progress hubs → docs/dictionary-progress.md
  deck.js/swiper.js                 Word Swiper                           → docs/word-swiper.md
  settings.js        native language, default reading language, active (per-book)
                     reading language, home-server URL, profile, AI model,
                     reading mode/font, read-aloud voice + speed, shelf sort
  main.js            view switching (shelf | server | dictionary | progress |
                     reader | swiper) and wiring
```
