# The Immersive Reader — Library & `.tir` Book Format (implemented)

The digital bookshelf: many processed books kept on-device, opened instantly,
with per-book reading progress and a portable file format. Built in
`src/library.js` (IndexedDB stores), `src/shelf.js` (the shelf UI), `src/tir.js`
(the `.tir` format), and the view switching in `src/main.js`. The same `.tir` is
also the wire format for the home server's book store
([home-server.md](home-server.md) §3). The same stores also hold the reader's
**notes** (§4).

## 1. On-device storage

```text
IndexedDB "immersive-reader"
  store "books"      BookMeta = { id, title, addedAt, lang, kind?, cover?,
                                  coverSource?, coverWidth?, coverHeight?,
                                  progressParagraph, progressWord,
                                  progressUpdatedAt, lastOpenedAt?, sourceUrl?, … }
                                  (metadata, small; kind: 'book' | 'note';
                                   sourceUrl: the page a note was imported from)
  store "content"    { text, images: [{ start, width, height, blob, src? }],
                       blocks: [{ start, end, type, level? }],
                       marks?: [{ start, end, type }],
                       source?, mdVersion? }
                       (heavy, by id; source = a note's raw text, mdVersion = the
                        Markdown parser version it was parsed with)
  store "bookwords"  per-book word data, versioned & recomputed when stale:
                     unique lemmas, occurrence counts (the swiper deck's
                     frequency ranking) and per-sentence word indexes (the
                     shelf's readability badge)
  store "kv"         small values (e.g. last-opened book)
```

- A book is extracted **once** (PDF/EPUB ingestion is the expensive step);
  reopening is instant.
- **Vocabulary stays global per language** (`<lang>:<word>` in localStorage) —
  shared across all books, which is the point of the tool. Only reading
  *position* is per-book: stored **paragraph-anchored** (`progressParagraph` +
  the Nth word inside it, see [design.md §5](design.md)) so it survives a device
  swap, and synced through the home server keyed by book title
  ([home-server.md §4a](home-server.md)).
- Each book carries its own **reading language** (`lang`), asked on add
  (defaulting from Settings) and editable from the book card or the reader menu.
  It drives tokenization, vocabulary keys, dictionary lookups and red-sea
  suppression.
- Blobs are stored directly (no base64). An old single-document record is
  migrated into a Book on first run after upgrade.

## 2. Shelf UI

Grid/list toggle, cover, editable title, sorting (last read / title / date
added), per-book actions: open, practice (swiper), **cover image**, export
`.tir`, upload to the home server (☁), change language, rename, delete — *Read* is
the card's only visible icon; the rest live in its ⋮ menu, each row an icon with its
label (*Delete* in the danger color). Opening
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
  manifest.json   { format: "tir", version: 2, id, title, addedAt, lang,
                    cover, coverMime, coverSource, coverWidth, coverHeight,
                    images: [{ file, mime, start, width, height }],
                    blocks: [{ start, end, type }] }
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
- `blocks` (v2) is the document's structure — headings / list items / code /
  quotes / table rows / breaks as char ranges over `text.txt` (the contract lives in
  `src/ingest/index.js`, rendering in [design.md §3](design.md)). v1 files import
  fine: no blocks means the flat flow of paragraphs they always were. `marks`
  (inline bold / italic / code spans) is an **optional** v2 field: a file without it
  reads as plain text, and an older app simply ignores it.
- Import tolerates missing image entries and rejects newer-version files with a
  clear message. Language comes from the manifest, so no language prompt on
  import.

## 4. Notes

A **note** is a text the reader writes or pastes — typically something to listen to
(a long answer, an article) without the voice reading Markdown symbols aloud. It is
stored as a library record with `kind: 'note'` and opens in the **same reader** as a
book (same colors, bubbles, read-aloud); what it adds is **editing**. Notes are kept
out of `listBooks()`, so they never appear on My Books or in Progress. Built in
`src/notes.js` (the Notes hub) and `src/notesEditor.js` (the editor).

- **Notes hub** (its own bottom-nav item): text cards — title, a preview of the
  clean reading text, when it was last opened, its word count and, for an imported
  page, the site it came from — sortable and switchable between cards and a compact
  list. Each card's ⋮ holds *Edit text*, *Language*, *Rename*, *Delete*; as on the
  book cards, every ⋮ entry is an icon **with its label** (a touch screen has no
  hover to explain a bare icon).
- **Entering a note:** ONE **+** button opens a menu of labeled choices — *Write a
  note* (a blank editor), *Import from a link* (below), *Import a file* (a `.md` /
  `.txt`, asking its language — offering My language first — then opening it in the
  reader). The empty hub offers *New note* and *Import from a link* directly.
  Settings → Diagnostics → *Save log to Notes* also creates one.
- **Import from a link** (`src/webImport.js`) turns a web page into a note: the
  article's text with its structure and emphasis — **no ads, menus, comments or
  newsletter boxes** — plus its **main pictures** (up to 8, with their captions),
  saved to read offline. It accepts a bare address or a shared text containing one;
  progress shows on the hub; failures say why (and land in the diagnostics log). On
  the phone the address field comes **pre-filled** when the clipboard holds a link.
  - **Wikipedia** (desktop or mobile URLs, any language edition) is read from its
    REST API's clean article HTML, which is CORS-open — it works on the web and the
    phone with **no server**. References, navigation boxes, hatnotes, the infobox's
    data table and the trailing apparatus sections (*References*, *See also*,
    *External links*… in every supported language) are dropped; the **infobox's
    picture becomes the article's opening figure**. The note's language is the
    wiki's own (`es.wikipedia` → Spanish, `simple` → English).
  - **Any other page** goes through Mozilla's **Readability** (Firefox's reader
    view, loaded only when an import runs), after removing blocks whose class/id
    marks them as clutter (newsletter, share, ads, cookie banners, "recommended"…)
    — never a block that is mostly prose. The title drops the site's name; the
    language is the page's `<html lang>`. A browser may only read another site's
    page when that site allows it (CORS): the **APK fetches natively**
    (`CapacitorHttp`, already part of the installed app); the **web build** falls
    back to the home server's `/fetch` proxy ([home-server.md](home-server.md) §6).
  - Either way the page becomes **Markdown** (`src/ingest/htmlToMarkdown.js`) — the
    note's editable source, parsed like any note — with each figure as an
    `![caption](src)` line: the parser anchors the picture there and shows the
    caption under it. The pictures are stored **with their `src`**, so an edit or a
    parser re-parse anchors them again (a figure deleted from the source drops out).
    Pictures are scaled to ≤ 1200 px (WebP); icons under 120 px are skipped. When the
    page names no language the app reads, it asks (offering My language).
- **The editor** is a plain text area under an optional title. **Paste** (drops
  the clipboard in at the cursor) sits in the **top bar** — the bottom toolbar can
  end up under the phone's keyboard — and an empty note also offers a large
  **Paste from clipboard** right under the title, which steps aside once there is
  text. A new note does not pop the keyboard by itself (tapping the text starts
  writing), and pasting leaves the keyboard closed: the next step is usually Save.
  The bottom toolbar holds the note's **language** — a visible chip that starts on
  **My language** for a new note and changes with one tap; it is never auto-detected
  and never asked in a dialog — and the word count. The gear holds the text settings
  (font, size, line spacing), which are the reader's own. On the phone the clipboard
  is read natively (`src/clipboard.js`); when it cannot be read (an APK without the
  clipboard plugin, a non-secure web origin) the editor says so, puts the cursor in
  the text for a manual long-press paste, and records why in the diagnostics log; an
  empty clipboard says so too.
- **Share → The Immersive Reader** (Android): text or a link shared from any app
  lands in Notes — a link is imported as a page (below), text opens a new note in the
  editor already filled in (its subject as the title), and a share while a note is
  being edited goes in at its cursor ([android.md](android.md)).
- **Saving opens the note in the reader** — writing → listening is one action, and
  back from the reader returns to Notes. The text is parsed as Markdown into the
  reading text + `blocks` (`src/ingest/md.js`); the raw text is kept as `source`,
  which is what *Edit text* reopens. Because the source is kept, a note saved under
  an older Markdown parser (`mdVersion`) is **parsed again** when it is opened or
  listed, so parser improvements reach existing notes too (title, language and
  position are untouched; a re-parse that splits or merges paragraphs can move the
  position slightly). Saving an edit **keeps the reading position**
  (paragraph-anchored and clamped on restore, so a shortened text cannot leave it
  past the end) and reopens the reader there.
- **Leaving with unsaved changes asks first** — *Keep editing* / *Discard* — from the
  editor's back arrow and from the Android back button alike; an empty new note
  leaves without asking. The Android back button closes an open dialog before it
  navigates anywhere.
