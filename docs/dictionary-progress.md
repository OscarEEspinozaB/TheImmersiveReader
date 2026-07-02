# The Immersive Reader — Dictionary & Progress Hubs (implemented)

Two sibling first-level destinations under the persistent bottom navigation —
**Library · Server · Dictionary · Progress** — replacing the earlier single
"Vocabulary dashboard" with internal tabs. Built in `src/dashboard.js` (+
`stats.js`, `charts.js`, `kbDetails.js`), wired in `src/main.js` / `index.html`.
The nav hides while reading and in the swiper (immersive), respects
`env(safe-area-inset-bottom)`, and highlights the active destination.

Why two places: **Progress** is the user's own learning (counts, growth,
per-book breakdown); **Dictionary** is reference content (word → meanings).
Nesting one inside the other conflated them.

## 1. Data model

Vocabulary entries carry timestamps — `<lang>:<word> → { state, at }` where `at`
is the last state-change (epoch ms). That single field powers the growth charts:
each known/learning word contributes at the date it reached its state. Legacy
string-format entries migrate on load; export/import round-trips `at`.

## 2. Per-language scoping

Vocabulary, definitions cache and the KB are all keyed `<lang>:<word>`, so **each
language is a separate dictionary and separate progress — never mixed**. Both
hubs carry a language switcher (a `select` listing every language that has
marked words); switching re-aligns the whole stack via `setActiveReadingLang`
and re-renders. The per-book breakdown filters to books in the selected
language.

## 3. Progress hub

- Summary cards: Known, Learning, total engaged, % known. The **Known and
  Learning cards are real buttons** that deep-link into the Dictionary
  pre-filtered (the two surfaces agree by construction).
- A known-vs-learning donut and a cumulative **growth line chart** (inline SVG,
  no chart dependency), derived by bucketing each word's `at`.
- Per-book breakdown of marked words.

## 4. Dictionary hub

- Search box, filter chips **All / Known / Learning / Built** (`aria-pressed`),
  and a Recent ⇆ A–Z sort toggle. Search/sort/filter persist across hub
  switches.
- The **Built** filter browses the home server's refined dictionary as it grows
  (`/words`), independent of what the user has marked.
- A **dictionary-data stats card** (`/stats`): words built, with
  synonyms/antonyms, built today/this week, by model, recent builds, raw KB base
  size.
- Each row shows the word, a **🔊 pronounce button** (`src/speech.js`, Web
  Speech, voiced in the hub's language — hearing the word is part of knowing
  it), a state chip colored like the reader, its dictionary definition, and the
  expandable **AI context history** (each explanation with its sentence).
  KB-backed rows surface part of speech, verb tenses, synonyms/antonyms and
  lemma links (`kbDetails.js`). Rows without a cached meaning offer an on-demand
  look-up. Changing a word's state here updates it everywhere (same global
  store).
- The list is **windowed** (IntersectionObserver chunk load/unload) so large
  vocabularies stay smooth.

Accessibility: interactive cards/nav items are real `<button>`s, chips expose
`aria-pressed`, hover effects are guarded by `prefers-reduced-motion`.
