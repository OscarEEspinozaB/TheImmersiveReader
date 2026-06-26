# The Immersive Reader — Personal Dictionary Knowledge Base (Design)

> Status: **Proposed.** Last updated 2026-06-24.
>
> Builds on the existing definitions layer (`definitionsCache.js`, the
> `DefinitionProvider` chain) and the `.tir` book-format pattern (`library-design.md`).
> Does **not** replace either — it adds a new, language-keyed knowledge base that is
> generated once per word in batch, and read at runtime with zero network calls.

## 1. Context

The reader already fetches definitions *on demand*, one word at a time, with a
provider chain (cache → dictionaryapi.dev → Ollama). That's the right design for a
single lookup, but it isn't what's being asked for here: a **complete, personal
dictionary** covering the full Harry Potter vocabulary (tens of thousands of unique
lemmas across the 7 books), generated mostly by AI and offline linguistic data,
**owned and stored locally**, with no recurring dependency on any external API.

A second requirement changes the shape of the design: this has to stay useful as the
user learns more languages (Spanish first, then Korean, Mandarin, eventually
Klingon's pIqaD). The schema needs to be open by construction, not English-shaped
with Spanish bolted on.

A third requirement: AI models will keep getting better and cheaper. The user wants
to **re-run generation later with a stronger model** and have it *improve* the
knowledge base — without clobbering anything they've manually corrected or curated.
That means every field needs to know where it came from and whether it's protected.

## 2. Goals

- **Batch-generate** a complete entry for every unique word across the whole library,
  per target language — once, not per page-turn.
- **Zero runtime network calls** for any word already in the knowledge base. The
  existing on-demand provider chain remains, but only as a fallback for words that
  truly aren't in the KB yet (e.g. a newly added book).
- **Local-first storage** (IndexedDB) plus a **portable export package**, so the KB
  can be generated once (e.g. on a home machine already running Ollama) and carried
  to any other device — phone, laptop — without recomputing anything.
- **Open language schema**: adding Korean or Klingon later means adding one adapter
  and one table row, not redesigning the data model.
- **Re-refinable over time**: a future, better/cheaper model can re-generate AI-sourced
  fields while user-edited ("locked") fields are never touched.
- **Provenance on every field**: always know whether a definition came from a real
  offline dictionary, a free API, an LLM, or the user themself.

## 3. Non-goals

- A live machine-translation *service*. Translation for words outside the pre-built
  KB still goes through Ollama on-demand, as already designed.
- A relational database / SQL server. `word → structured record` has no joins worth
  paying server overhead for; IndexedDB (and a flat export file) is enough at this
  scale (low tens of thousands of entries × a handful of languages is a few MB).
- Promising completeness for every language. Some (Klingon, see §9) currently have no
  usable open dataset — the gap is acknowledged, not hidden behind a generic "AI will
  handle it" claim.

## 4. Two-layer architecture

```text
GENERATION (offline, batch, can take hours, resumable)
  Unique words from the whole library (per language)
        │
        ▼
  Source cascade per word  (offline dataset → free API → Ollama)
        │
        ▼
  dictionaryKB  (IndexedDB)  ──export──▶  .tirdict package (portable)

CONSUMPTION (runtime, instant, no network)
  Reader popup / Dictionary tab / Word Swiper
        │  read-only lookup
        ▼
  dictionaryKB
        │  miss (word not generated yet for this language)
        ▼
  existing on-demand DefinitionProvider chain (unchanged, still the fallback)
```

The reader's word-state logic (`vocabulary.js`) is untouched by this design: the KB
supplies *information about* a word, never its known/learning/unknown state, exactly
like the existing invariant ("state is never changed automatically").

## 5. Data model

### 5.1 Entry shape (per word, per language)

```text
DictionaryEntry = {
  id: string                  // `${lang}:${normalizedWord}`, e.g. "en:wand"
  lang: string                 // ISO 639 code — open-ended, see §5.3
  word: string                  // normalized lemma
  displayForm?: string           // surface form for display (e.g. Hanzi + pinyin)
  pos?: string[]                  // one or more parts of speech

  senses: [{
    id: string
    definition: string
    exampleSentence?: string       // pulled from the actual book, when available
    sourceBook?: string
    synonyms?: string[]
    antonyms?: string[]
    translations?: { lang: string, text: string }[]   // per-sense, not one global field —
                                                        // "bank" (river) vs "bank" (money)
                                                        // need different Spanish words
  }]

  notes?: string                  // free-form: etymology, usage, personal notes

  provenance: {
    // one entry per field path that was set, e.g. "senses.0.definition"
    [fieldPath: string]: {
      source: "offline-dataset" | "dictionary-api" | "ai" | "manual"
      sourceName?: string           // "WordNet 3.1" | "CC-CEDICT" | "gemma3:4b" | ...
      generatedAt: number
      locked?: boolean               // true once the user edits it directly —
                                       // a locked field is never auto-overwritten
                                       // by a later refinement pass
    }
  }

  schemaVersion: number
}
```

Per-sense translations (rather than one flat `translations` array on the entry) is
the one deliberately opinionated choice here: a personal dictionary is only useful if
it disambiguates senses, and that's exactly the kind of thing a context-aware model
can do that a generic bilingual list can't.

### 5.2 Field-level provenance & locking

This is what makes "re-run with a smarter model later" safe:

- A refinement pass only touches fields whose `provenance[field].source === "ai"`
  **and** `locked` is not `true`.
- Editing any field anywhere in the app sets `source: "manual"` and `locked: true`
  on that field — permanently protecting it from automated regeneration.
- `sourceName` records which model/dataset produced it, so the user can later ask
  "show me everything still generated by the old small model" and selectively
  re-refine just those.

### 5.3 Language registry (open by design)

Adding a language is "implement one adapter, add one row" — not a schema change.

A word's source language is **a property of the book it came from**, not a global
setting: each book carries its own `lang`, chosen manually at import, and that is what
keys its KB entries (`${lang}:${word}`), selects its tokenizer, and picks its offline
dataset. The user's native language (for per-sense `translations`) stays a separate,
per-user setting. See the implementation plan's §1 (book language) for the data-model
and integration details.

| Code (ISO 639) | Language | Tokenizer readiness | Status |
| --- | --- | --- | --- |
| `en` | English | `Intl.Segmenter` — ready today | **Active** |
| `es` | Spanish | `Intl.Segmenter` — ready today | Planned (next) |
| `ko` | Korean | `Intl.Segmenter` handles boundaries reasonably; agglutination needs review | Planned |
| `cmn` (often tagged `zh`) | Mandarin | `Intl.Segmenter` does **not** do real Chinese word segmentation — needs a dedicated segmenter | Planned |
| `tlh` | Klingon (pIqaD) | No `Intl.Segmenter` support; needs a custom affix-aware tokenizer | Experimental / curation-only |
| *(future code)* | *(future language)* | *(implement adapter)* | Planned |

A **language adapter** is the minimal contract a new row needs to implement:

```text
LanguageAdapter = {
  code: string                          // ISO 639-1/2/3
  name: string
  tokenizer: "intl-segmenter" | "custom" // which tokenizer module to load
  offlineSource?: { name, format, url, license }  // see §9 per language
  status: "active" | "planned" | "curation-only"
}
```

## 6. Storage

### 6.1 IndexedDB store `dictionaryKB`

```text
IndexedDB "immersive-reader"
  store "dictionaryKB"   (keyed by id = `${lang}:${word}`)
    → DictionaryEntry (§5.1)
    index "byLang"  on `lang`
  store "generationProgress"   (small, one row per in-progress batch job)
    { lang, cursor, total, done, startedAt, status: "running"|"paused"|"done"|"error" }
```

Kept as its **own** store, separate from `definitionsCache` (which stays as the
lightweight on-demand cache/fallback) and from `vocabulary` (which stays the
authoritative known/learning/unknown state). Three stores, three responsibilities,
no overlap.

### 6.2 Portable package: `.tirdict`

Same pattern as the `.tir` book format, so generation can happen once on a capable
machine (e.g. the one already running Ollama per the README) and be carried to any
other device without recomputation:

```text
en.tirdict  (zip)
  manifest.json    { format: "tirdict", lang: "en", schemaVersion, wordCount,
                     generatorModel, builtAt }
  entries.ndjson   one DictionaryEntry per line (streamable — never load the
                     whole file into memory at once; matters once this is
                     20k+ entries)
```

One file per language (`en.tirdict`, `es.tirdict`, …) rather than one combined file,
so updating or sharing a single language doesn't require touching the others.

## 7. Generation pipeline

1. **Collect the vocabulary.** Reuse the per-book unique-word lists already
   computed for the library/stats views — no new extraction logic needed.
2. **Per word, per language, run the source cascade:**
   - **Offline dataset first** (no network, no key): WordNet-style data for English,
     CC-CEDICT for Mandarin, KRDICT for Korean (see §9). User-provided dump files,
     parsed once into the KB.
   - **Free keyless API fallback** for English gaps: `dictionaryapi.dev` (the
     non-AI fallback already used elsewhere in the project).
   - **Ollama for everything else**: sense disambiguation against the book's actual
     sentence, synonyms/antonyms, per-sense translation, and the in-universe
     neologisms no standard dictionary has (*Quidditch*, *Muggle*, *Horcrux* — these
     are AI-or-curation-only by nature, no dataset will ever have them).
   - Every field gets stamped with the provenance of whichever source actually
     produced it.
3. **Run in a Web Worker**, never the main thread — a full-library batch against a
   local LLM is a multi-hour job.
4. **Resumable by construction**: `generationProgress` is written every N words, so a
   closed tab or a restarted Ollama doesn't lose completed work — generation restarts
   from the last cursor, not from zero.
5. **Sequential, not parallel**, against Ollama: one local model has no benefit from
   request flooding and it just adds contention.
6. **Write-through**: each completed entry is committed to `dictionaryKB` immediately,
   so the reader can start benefiting from a still-running batch instead of waiting
   for full completion.

## 8. Refinement workflow (the "control + improve later" requirement)

- A **"Re-refine with model X"** action, scopable by language and/or field type, that
  re-runs generation **only** over entries where `provenance[field].source === "ai"`
  and `locked` is falsy — replacing `sourceName`/`generatedAt`, never touching a
  locked field.
- Any manual edit (future Dictionary-tab edit action) sets that field's `locked: true`
  permanently — the user's own corrections are the one thing the system will never
  silently overwrite, no matter how good the next model is.
- `schemaVersion` on every entry enables batch migrations the same way the project
  already migrates vocabulary/contraction data on load.

## 9. Per-language reality check

| Language | Realistic offline source | Caveat |
| --- | --- | --- |
| English | WordNet / an English Wiktextract dump | Mature, large, free |
| Spanish | A Spanish Wiktextract / Wikcionario dump | Good coverage, free |
| Korean | KRDICT (National Institute of Korean Language) | Free, structured, but agglutination makes tokenization non-trivial |
| Mandarin | CC-CEDICT | Free, exactly built for this; **tokenizer is the real gap** — needs a dedicated Chinese segmenter, `Intl.Segmenter` won't do real word boundaries here |
| Klingon (pIqaD) | **None structured/open.** Community sources (*The Klingon Dictionary*, boQwI') exist but with unclear redistribution rights | This is the honest exception: realistically curation-only or AI-assisted-with-low-confidence for the foreseeable future — not a gap that "AI will just solve" |

This table is the living artifact — adding a language later means adding a row here
and an adapter (§5.3), nothing else in the architecture changes.

## 10. Integration with existing modules

- **`vocabulary.js`** — unchanged. The KB never sets word state.
- **`definitionsCache.js`** — unchanged in role; remains the on-demand path for any
  word not yet present in `dictionaryKB` (new book added later, or a language whose
  batch hasn't run yet).
- **`dashboard.js` (Dictionary tab)** — add a language selector; when a KB entry
  exists, surface its synonyms/antonyms/per-sense translations alongside the existing
  dict/AI panorama; show a pin icon on locked (user-curated) fields.
- **`deck.js` / `images.js`** — unaffected; can optionally read a KB entry's
  `senses[].exampleSentence` instead of re-deriving a sample sentence.

## 11. Milestones

1. Schema + `dictionaryKB` store + English-only batch generator (offline dataset →
   dictionaryapi.dev → Ollama), Web Worker, resumable.
2. `.tirdict` export/import (zip via fflate, streamed ndjson).
3. Field-level provenance + locking + the "re-refine" action.
4. Spanish adapter (per-sense translations populated via Ollama).
5. Korean + Mandarin adapters (tokenizer work, offline dataset loaders).
6. Klingon — experimental, curation-only adapter; revisit if/when a redistributable
   structured dataset appears.

## 12. Open questions

- Do offline dataset dumps (WordNet, CC-CEDICT, KRDICT) ship bundled in the repo
  (sizeable), or get drag-and-dropped by the user once and parsed locally into the KB?
- Should the "re-refine" action be all-or-nothing per language, or selectable down to
  individual words/senses?
- Mandarin/Korean tokenizers: load a WASM segmenter eagerly, or lazily per language
  adapter only when that language is actually used?
- Should `.tirdict` files be allowed to merge (importing a newer one fills gaps/updates
  unlocked fields in an existing local KB) rather than only replace wholesale?
