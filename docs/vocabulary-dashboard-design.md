# The Immersive Reader — Vocabulary Dashboard & Dictionary (Design)

> Status: **Implemented.** Vocabulary entries now carry timestamps (`{state, at}`);
> Stats tab has summary cards, a known-vs-learning donut, a growth line chart, and a
> per-book breakdown; Dictionary tab has search/filter/sort, dictionary + AI meanings,
> on-demand look-up for missing/new words, and a **windowed** list for large
> vocabularies. Built in `src/dashboard.js`, `src/stats.js`, `src/charts.js`. Last
> updated 2026-06-24.

## 1. Context

The whole point of the app is watching vocabulary grow (the "red sea" fading). A
dedicated **Vocabulary** view would let the user *measure* that: how many words are
Known vs Learning, how that grows over time, and a personal **dictionary** of the
words they've engaged with — including both the cached dictionary definitions and the
context-aware explanations the AI already produced (stored in `definitionsCache`).

This is a third top-level view alongside the **Library** (shelf) and the **Reader**.

## 2. Goals

- **Stats**: current counts of Known and Learning words; simple growth over time.
- **Dictionary**: browse the words you've marked, with their meanings from the
  dictionary cache AND the AI's per-context explanations we already store.
- Filter (by state), search, and sort the dictionary.
- No new dependency: charts drawn with inline SVG (fits the minimal aesthetic).

## 3. Non-goals

- Spaced-repetition / flashcards (could be a later feature).
- Per-book vocabulary stats (vocabulary is global by design).

## 4. What we already have vs. what's missing

Already stored:

- **Vocabulary** (`vocabulary.js`): `word → state` (known/learning). Default unknown
  words are NOT stored (so "unknown count" isn't meaningful — it's "everything else").
- **Definitions cache** (`definitionsCache.js`): per word, the `dictionary` result and
  an `ai` history of `{ sentence, explanation, source }` per context, plus `lang`.

Missing for history/graphs:

- **Timestamps.** The vocabulary store has no notion of *when* a word became known or
  learning, so we can't chart growth yet.

## 5. Data model change (for history)

Upgrade the vocabulary store from `word → state` to `word → { state, at }` where `at`
is the last-change timestamp.

```text
Vocabulary (localStorage, bumped key/version)
  word -> { state: "known"|"learning", at: epochMs }
```

- Migration: existing `word → "known"` becomes `{ state: "known", at: now }` on load.
- `getState` / `setState` keep their signatures; `setState` records `at = Date.now()`.
- Export/import: include `at` (older files without `at` import with `at = now`).

This single change unlocks growth charts cheaply: each known/learning word carries the
date it reached that state. (A word that changes state again just updates `at`.)

Optional refinement (later): a tiny **daily snapshot log** `[{date, known, learning}]`
for exact day-by-day totals, in case last-change-only charts feel coarse.

## 6. Views

A new **Vocabulary** screen with two tabs: **Stats** and **Dictionary**.
Reached from the top bar / menu (e.g. a "chart" icon, like the library icon).

### 6a. Stats tab

- **Summary cards**: Known (N), Learning (N), Total engaged (N), % Known of engaged.
- **Growth chart** (inline SVG line chart): cumulative Known and Learning over time,
  derived by bucketing each word's `at` by day/week and accumulating.
- **Recent activity**: words moved to Known/Learning in the last 7/30 days.

```text
┌───────────────────────────────┐
│  Vocabulary        [Stats][Dict]│
│  ┌────────┐ ┌────────┐ ┌──────┐ │
│  │Known 312│ │Learn 87│ │ 78% │ │
│  └────────┘ └────────┘ └──────┘ │
│  Growth                         │
│   known  ╭─────────              │
│         ╭╯      learning ╭──     │
│  ───────┴───────────────┴────►   │
│      this month                  │
└───────────────────────────────┘
```

### 6b. Dictionary tab

- **Search** box + **filter** (All / Known / Learning) + **sort** (A–Z / recent).
- A list of entries; each shows:
  - the word + a state chip (colored like in the reader),
  - the **dictionary** definition (from cache) if present,
  - the **AI explanations** — expandable, showing the per-context history we store
    (each with its sentence), reusing the same panorama as the popup.
- Words with no cached meaning show just the state (optionally a "look it up" action
  that fetches + caches, respecting AI availability).
- Changing a word's state here updates it everywhere (same global store).

```text
┌───────────────────────────────┐
│ 🔍 search   [All|Known|Learn] ⇅ │
│ ───────────────────────────── │
│ wand            ● learning      │
│   dict: a thin stick used for…  │
│   ▸ AI: a magic stick … (ctx 1) │
│ ───────────────────────────── │
│ owl             ● known         │
│   dict: a bird of prey active…  │
└───────────────────────────────┘
```

## 7. Modules

- `vocabulary.js` — store `{state, at}`; add `counts()` and `entries()` accessors.
- `stats.js` — derive summary counts and the cumulative growth series from entries.
- `definitionsCache.js` — add `getAllCached()` to list cached words + their data for
  the dictionary tab.
- `dashboard.js` (+ a small `charts.js` for SVG line/donut) — render the Vocabulary
  view; reuses state colors and the AI panorama rendering.
- `main.js` — add the third view to the shelf/reader/dashboard switcher.

## 8. Milestones

1. **Timestamps**: migrate vocabulary to `{state, at}`; update get/set/export/import.
2. **Stats tab**: summary cards + cumulative growth SVG chart.
3. **Dictionary tab**: searchable/filterable list with dictionary + AI explanations.
4. Polish: recent-activity, per-week deltas; optional daily snapshot log; CSV export.

## 9. Open questions

- Chart granularity: by day or by week? (Auto-pick based on date range.)
- Should the dictionary let you look up words you marked but never opened? (Default:
  show on demand, respecting AI availability.)
- Where to surface the entry point: top bar icon, library bar, or menu?
