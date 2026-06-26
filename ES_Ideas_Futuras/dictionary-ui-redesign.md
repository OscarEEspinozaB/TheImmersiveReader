# The Immersive Reader — Dictionary & Stats UI Redesign (Implementation Plan)

> Status: **Proposed (implementation plan).** Last updated 2026-06-25.
>
> Scope: make the vocabulary view (reached via the **stats icon**) more minimal and
> intuitive, and make the **Known** and **Learning** stat cards act as buttons that
> jump straight into the Dictionary tab with that filter already applied. Implemented
> in [src/dashboard.js](../src/dashboard.js); CSS in
> [src/styles/main.css](../src/styles/main.css). This is the front-of-house companion
> to [dictionary-knowledge-base-implementation.md](dictionary-knowledge-base-implementation.md).

## 1. Context

The dictionary lives under the **stats icon**: the top-level "Vocabulary" view
([src/dashboard.js](../src/dashboard.js)) opened from the library, with two tabs —
**Stats** and **Dictionary**. Today the two tabs feel disconnected: Stats shows
counts (`Known`, `Learning`, `Total`, `This week`) as inert cards, and Dictionary has
its own `All / Known / Learning` `<select>` filter. The user has to mentally connect
"I have 312 known words" with "now switch tab, open the filter dropdown, pick Known."

The fix is to make the counts the entry point: **the Known and Learning cards become
buttons** that open the Dictionary tab pre-filtered. Same data, one click instead of
three, and the numbers stop being decorative.

## 2. Goals

- Known / Learning stat cards are **clickable** → open Dictionary tab filtered to that
  state, scrolled to top.
- The Dictionary tab reflects the incoming filter (the existing `state.filter` already
  drives the list — we just set it before switching tabs).
- A **minimal, more intuitive** dictionary surface: replace the row of `<select>`
  dropdowns with inline filter **chips** (matching the existing pill-style
  `.dash__tab`), keep search, and make the active state obvious.
- No new dependency, no new view. Pure `dashboard.js` + CSS. State invariants and the
  KB design are untouched.

## 3. Non-goals

- No change to vocabulary state logic, counts, or storage.
- Not the Dictionary KB itself (that's the companion implementation doc). This redesign
  is compatible with it: when the KB lands, its richer fields render inside the same
  rows.

## 4. What exists today (grounding)

- **Shared tab state** already lives in one object:
  `state = { tab, search, filter, sort }` ([src/dashboard.js](../src/dashboard.js#L26)).
  `renderBody()` reads `state.tab`; the dictionary list reads `state.filter`. So a
  deep-link is just: set `state.tab='dictionary'`, `state.filter='known'`, re-render.
- **Stat cards** are built by `statCard(label, value)`
  ([src/dashboard.js](../src/dashboard.js#L159)) — currently a plain `<div>`.
- **Dictionary filter** is a `<select>` from `select([...])`
  ([src/dashboard.js](../src/dashboard.js#L185)); `renderList()` filters
  `listEntries()` by `state.filter`.
- **Tab buttons** are pill-styled `.dash__tab` ([main.css](../src/styles/main.css#L877)).
  Stat cards are `.stat-card` ([main.css](../src/styles/main.css#L911)).

Everything needed for the deep-link is already wired; this is a small, well-contained
change.

## 5. Design

### 5a. Clickable stat cards

`statCard` gains an optional `onClick`. When present, render a `<button>` instead of a
`<div>` (keyboard-accessible, focusable, correct semantics), keep the `.stat-card`
look, add a subtle affordance (hover lift / `cursor: pointer` / a faint `›`).

```text
┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
│   312  › │ │   87   › │ │  399   │ │   +24    │
│  Known   │ │ Learning │ │ Total  │ │ This week│
└──────────┘ └──────────┘ └────────┘ └──────────┘
   button       button      (plain)     (plain)
```

`renderStats` wires the two interactive cards to a new `goToDictionary(filter)`:

```js
cards.append(
  statCard('Known', s.known, () => goToDictionary('known')),
  statCard('Learning', s.learning, () => goToDictionary('learning')),
  statCard('Total', s.total),
  statCard('This week', `+${r.known + r.learning}`),
);
```

`goToDictionary` needs access to the shared `state` + the tab switcher. The cleanest
wiring: `renderStats(body)` is already called from inside `renderDashboard` where
`state`, `updateTabs`, and `renderBody` are in scope. Pass a small callback down:

```js
// in renderDashboard:
if (state.tab === 'stats')
  renderStats(body, (filter) => { state.tab = 'dictionary'; state.filter = filter;
                                   updateTabs(); renderBody(); });
else renderDictionary(body, state, root);
```

So `renderStats(body, goToDictionary)` and the two cards call `goToDictionary('known'|'learning')`.

### 5b. Minimal dictionary controls (chips instead of dropdowns)

Replace the two `<select>`s with **inline filter chips** reusing the pill aesthetic,
and keep search as the one text input. Sort (`Recent / A–Z`) becomes a single small
toggle on the right rather than a dropdown.

```text
┌─────────────────────────────────────────────┐
│  🔍  Search words…                    A–Z ⇅  │
│  ( All )  ( Known )  ( Learning )            │   ← chips; active one filled
│  ───────────────────────────────────────────│
│  wand            ● learning                   │
│    a thin stick used for magic…               │
│  owl             ● known                      │
└─────────────────────────────────────────────┘
```

- Chips are buttons; clicking one sets `state.filter` and calls `renderList()` (the
  list logic is unchanged — it already filters on `state.filter`).
- When the user **arrives via a stat card**, the matching chip is already active
  because `state.filter` was set before the tab switched — the two surfaces now agree
  by construction.
- Sort toggle flips `state.sort` between `recent` and `a-z` (same values the existing
  `select` used), so `renderList`'s sort comparator is untouched.

### 5c. Lighter rows

Minor polish, all CSS-only or trivial markup:

- The per-row state `<select>` ([dashboard.js](../src/dashboard.js#L299)) is visually
  heavy. Keep it (it's the quickest way to re-state a word) but style it down to a
  borderless chip that only shows its border on hover/focus.
- Tighten row padding and rely on the colored state dot + the `data-state` word color
  (already present) to carry the state, reducing redundant chrome.

## 6. CSS (`src/styles/main.css`)

- `.stat-card` → add a `button.stat-card` variant: `cursor: pointer`, `text-align`
  left, reset button defaults, `:hover` subtle `border-color: var(--text)` + tiny
  `translateY(-1px)`, visible `:focus-visible` ring. Non-interactive cards stay
  `<div>` and keep the current look.
- New `.dict-chips` row reusing `.dash__tab` / `.dash__tab.is-active` styling (or a
  shared `.chip` class extracted from it, so tabs and filter chips stay consistent).
- `.dict-controls` becomes `search` + a right-aligned sort toggle; the chip row sits
  below it. Drop `.dict-select`'s usage here (the per-row state select can keep a
  slimmed variant).

## 7. Implementation steps

1. **`statCard` → optional `onClick`** renders a `<button>`; add the `button.stat-card`
   CSS. (Self-contained; no behavior change when `onClick` is absent.)
2. **Deep-link:** thread `goToDictionary(filter)` from `renderDashboard` into
   `renderStats`; wire the Known/Learning cards.
3. **Filter chips:** replace the filter `<select>` in `renderDictionary` with a chip
   row driven by `state.filter`; keep `renderList` as-is.
4. **Sort toggle + lighter rows:** swap the sort `<select>` for a small toggle; CSS
   polish on rows and the per-row state select.
5. Manual verify (`npm run dev`): mark some words, open stats, click Known → lands in
   Dictionary filtered to Known with the Known chip active; click Learning likewise;
   search still works; sort toggles.

Steps 1–2 deliver the headline behavior (clickable counts) and can ship alone; 3–4 are
the minimalist polish and can follow.

## 8. Accessibility & details

- Interactive cards are real `<button>`s (Enter/Space, focus ring, screen-reader
  "button"); decorative cards stay `<div>`.
- Chips are buttons with `aria-pressed` reflecting the active filter.
- Respect `prefers-reduced-motion` for the hover lift.
- Returning to Stats and back preserves `state.filter` (it already persists on the
  shared `state` object for the dashboard's lifetime).

## 9. Relationship to the KB redesign

This redesign only touches presentation and navigation. When
[dictionary-knowledge-base-implementation.md](dictionary-knowledge-base-implementation.md)
lands, the same dictionary rows gain KB-sourced synonyms/antonyms/per-sense
translations and a pin icon on locked fields, and a language selector joins the chip
row — no rework of the navigation built here.
