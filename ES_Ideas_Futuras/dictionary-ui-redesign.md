# The Immersive Reader — Dictionary / Progress UI restructuring

> Status: **Implemented (2026-06-26).** Supersedes the earlier tabs-based draft
> (clickable cards + chips *inside* the Vocabulary dashboard). The restructuring is
> deeper: **Dictionary and Progress are now sibling first-level destinations** under a
> persistent primary nav, not parent/child tabs.
>
> Code: [src/dashboard.js](../src/dashboard.js), [src/main.js](../src/main.js),
> [index.html](../index.html), [src/styles/main.css](../src/styles/main.css). This is the
> front-of-house companion to
> [dictionary-knowledge-base-implementation.md](dictionary-knowledge-base-implementation.md).

## 1. Why

Everything about "words" used to hang off **one chart icon** that opened a single
`#dashboard` with **two internal tabs — Stats and Dictionary**. That conflated two
different things:

- **Progress** = the user's own learning (counts, growth over time, per-book breakdown).
- **Dictionary** = the reference content (word → definition / cached AI / future KB).

Nesting the Dictionary *inside* the stats view made it feel like an annex of the numbers,
and reaching a filtered word list meant: open dashboard → switch tab → open a dropdown →
pick a state. The fix is a real separation with a dedicated navigation, so the Dictionary
is a first-class place and the counts become the entry point into it.

## 2. What shipped

### 2a. Primary navigation (persistent bottom bar)

A fixed bottom `#primary-nav` ([index.html](../index.html)) with three first-level
destinations — **Library · Dictionary · Progress** — each an icon-over-label
`button.nav-item`. It is shown only on the hub views and **hidden while reading and in the
swiper** (immersive), via a `body.nav-hidden` class toggled in `setView`
([src/main.js](../src/main.js)), mirroring the existing `chrome-hidden` pattern. The active
destination is highlighted. The old per-shelf "Vocabulary" chart icon is gone.

```text
┌──────────────────────────────────────┐
│            (active view)             │
├──────────────────────────────────────┤
│   📚         📖          📈           │
│ Library   Dictionary  Progress       │
└──────────────────────────────────────┘
```

*Practice* (the swiper) stays a per-book action launched from the shelf; a clean 4th nav
slot is left for it once a global deck exists.

### 2b. View model

`setView(view)` now handles `shelf | dictionary | progress | reader | swiper`. The single
`#dashboard` section is reused as the shared container for both hub views (same `.dashboard`
scroll/padding; its direct children share a centered `max-width` column). `main.js` exposes
`showProgress()` and `showDictionary(filter?)`; the nav buttons call `showShelf`,
`showDictionary()`, `showProgress`.

### 2c. Progress hub — counts as the entry point

`renderProgress(root, { onOpenDictionary })` ([src/dashboard.js](../src/dashboard.js))
renders the stat cards, donut split, growth chart and per-book breakdown. The **Known and
Learning cards are real `<button>`s** (`statCard(label, value, onClick?)` →
`button.stat-card--btn`) that **deep-link into the Dictionary pre-filtered** via
`onOpenDictionary('known'|'learning')`. Decorative cards (Total, This week) stay inert
`<div>`s.

### 2d. Dictionary hub — minimal controls

`renderDictionary(root, { filter })` replaces the two `<select>` dropdowns with:

- **filter chips** `All / Known / Learning` (`button.chip` with `aria-pressed`), seeded from
  the incoming `filter` so arriving from a stat card lands already filtered with the right
  chip active — the two surfaces agree by construction;
- a small **sort toggle** (`Recent ⇆ A–Z`) on the right of the search box.

```text
┌─────────────────────────────────────────────┐
│  🔍 Search words…                  [ Recent ]│
│  ( All )  ( Known )  ( Learning )            │  ← active chip filled
│  ───────────────────────────────────────────│
│  wand        learning                         │
│    a thin stick used for magic…               │
│  owl         known                            │
└─────────────────────────────────────────────┘
```

The windowed list logic (`renderList`, `IntersectionObserver`, `renderChunk`/`unloadChunk`,
`dictRow`, `lookupCard`) is unchanged — it already reads `state.filter / search / sort`. A
module-level `dictState` persists search/sort/filter across hub switches. The per-row state
`<select>` is styled down to a borderless chip (border on hover/focus) for lighter rows.

### 2e. Per-language scoping (each language is its own dictionary)

Vocabulary and definitions are keyed per reading language (`<lang>:<word>`), so **each
language is a separate dictionary and separate progress — never mixed**. Both hubs are scoped
to a single language and carry a **language switcher** (`langSwitcher` in
[src/dashboard.js](../src/dashboard.js)) at the top: a `select` listing every language that has
marked words (plus the one in view). Because the reading language is now a per-book property,
this switch lives **in the UI, not in settings**. Switching it sets `dashLang`, re-aligns the
whole stack via `setActiveReadingLang` (so state writes, lookups and caching target that
language), and re-renders. Concretely:

- `listEntries(lang)` / `counts(lang)` (and so `summary` / `growthSeries` / `recent`) take an
  optional language filter; `usedLanguages()` lists the languages that have words.
- The **Per book** breakdown is filtered to books written in the selected language.
- The **definitions cache** ([src/definitionsCache.js](../src/definitionsCache.js)) is keyed by
  `<lang>:<word>` too, so identical spellings across languages (`important`, `table`, `son`)
  keep independent definitions. (Earlier language-agnostic entries are orphaned and re-fetched.)

## 3. Accessibility & details

- Interactive cards and nav items are real `<button>`s (Enter/Space, focus ring); decorative
  cards stay `<div>`.
- Chips expose `aria-pressed`; the active filter is visually filled.
- The hover lift on stat cards is guarded by `prefers-reduced-motion`.
- The nav respects `env(safe-area-inset-bottom)` for PWA / notched devices.

## 4. Relationship to the KB redesign

This only restructures navigation and presentation. When
[dictionary-knowledge-base-implementation.md](dictionary-knowledge-base-implementation.md)
lands, its richer fields (synonyms/antonyms/per-sense translations, pinned/locked fields)
render inside the same `dictRow`s, and a language selector joins the chip row — no rework of
the navigation built here.
