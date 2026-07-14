# The Immersive Reader — Library & `.tir` Book Format (implemented)

The digital bookshelf: many processed books kept on-device, opened instantly,
with per-book reading progress and a portable file format. Built in
`src/library.js` (IndexedDB stores), `src/shelf.js` (the shelf UI), `src/tir.js`
(the `.tir` format), and the view switching in `src/main.js`. The same `.tir` is
also the wire format for the home server's book store
([home-server.md](home-server.md) §3).

## 1. On-device storage

```text
IndexedDB "immersive-reader"
  store "books"      BookMeta = { id, title, addedAt, lang, cover?, coverSource?,
                                  coverWidth?, coverHeight?, progressWordIndex,
                                  lastOpenedAt?, … }        (metadata, small)
  store "content"    { text, images: [{ start, width, height, blob }] }  (heavy, by id)
  store "bookwords"  per-book unique lemmas + occurrence counts (versioned;
                     recomputed when stale; counts weight the shelf's
                     comprehensibility score by running words)
  store "kv"         small values (e.g. last-opened book)
```

- A book is extracted **once** (PDF/EPUB ingestion is the expensive step);
  reopening is instant.
- **Vocabulary stays global per language** (`<lang>:<word>` in localStorage) —
  shared across all books, which is the point of the tool. Only reading
  *position* is per-book.
- Each book carries its own **reading language** (`lang`), asked on add
  (defaulting from Settings) and editable from the book card or the reader menu.
  It drives tokenization, vocabulary keys, dictionary lookups and red-sea
  suppression.
- Blobs are stored directly (no base64). An old single-document record is
  migrated into a Book on first run after upgrade.

## 2. Shelf UI

Grid/list toggle, cover, editable title, sorting (last read / title / date
added), per-book actions: open, practice (swiper), **cover image**, export
`.tir`, upload to the home server (☁), change language, rename, delete. Opening
a book restores its saved position; a back-to-shelf control returns. Empty state
prompts to add the first book.

### 2a. The cover

A cover has an **origin** (`src/cover.js`), and that is what makes it replaceable:

- `document` — the image the file itself opens with (an image anchored within the
  first ~200 characters). The default, and what every book had before covers were a
  concept of their own.
- `uploaded` — one chosen from the ⋮ menu. It replaces the cover on the shelf **and
  the book now opens with it**: it is anchored at offset 0, so the reader's existing
  image anchoring paints it before the first word — no special case in the reader.

One cover per book, always: choosing another replaces it. The document's own images
are never modified, so *Remove the uploaded cover* puts the original back (or leaves
the generated text cover, for a book that never had an image). An illustration deeper
in the text is **not** a cover and is never taken out of the book by an upload — only
an opening image steps aside.

Uploads are scaled in the browser before they are stored (longest side ≤ 1200 px,
WebP): a phone photo is several MB and would otherwise be carried at full size inside
every `.tir` the book is exported or uploaded as.

Each card shows a **readability badge**: `You can read N%` — the share of the
book's **sentences** that are fully readable right now, where a sentence counts
only when **every word in it is marked known** (words marked **discarded/exempt**
— proper nouns, code… — count as known here, so a cast of character names never
keeps a sentence unreadable). It is measured in units of
reading, not word statistics: three word-based framings ("% known",
token-weighted "new words", unique-word "new words") were rejected because none
matched the lived reality of opening the book — with a fresh vocabulary this
badge says 0%, exactly like the first page feels, and it rises as words are
marked. The tooltip gives the raw counts (`N of M sentences`). Colors: calm ≥
90%, gold 50–89%, red < 50%. Books in the user's native language show no badge
(no red sea). The per-sentence word indexes are precomputed with the book's
word list (v5) so the shelf only re-checks states; legacy books are tokenized
once in a background queue and cached.

## 3. The `.tir` file format

A self-contained ZIP (via fflate, already the EPUB dependency) so a processed
book can be backed up, moved between devices, or uploaded to the server without
re-running extraction:

```text
book.tir  (zip)
  manifest.json   { format: "tir", version: 1, id, title, addedAt, lang,
                    cover, coverMime, coverSource, coverWidth, coverHeight,
                    images: [{ file, mime, start, width, height }] }
  text.txt        the clean reading text
  images/0.png …  illustration blobs (zip-stored, level 0 — already compressed)
  cover.png       optional cover (shelf thumbnail + the book's opening image when
                  `coverSource` is "uploaded"; without that field the file would
                  forget that its cover can be taken back)
```

- A book already on the shelf is never added twice. Identity is tested by the
  manifest's **stable id** first and by **title** second: the same book ingested
  from its PDF on one device and downloaded from the server on another carries two
  different ids, and only the title catches that. A different cover or a renamed
  title is a library matter (edit the copy you have) — never a reason to hold two.
  Adding the same file from disk asks first, since re-extracting it is the expensive
  step.
- `manifest.id` is the book's **stable identity**: importing a `.tir` already in
  the library is a duplicate no-op instead of a second copy; the server dedupes
  uploads by the same id.
- Reading position and vocabulary are deliberately **not** embedded — vocabulary
  is global and position is per-device — so files stay portable and shareable.
- Import tolerates missing image entries and rejects newer-version files with a
  clear message. Language comes from the manifest, so no language prompt on
  import.
