# The Immersive Reader — Library & Book Format (Design)

> Status: **Implemented** (library/bookshelf, per-book progress, sorting). The `.tir`
> export/import file format is **still pending**. Last updated 2026-06-24.
>
> Built in `src/library.js` (IndexedDB books/content/bookwords stores), `src/shelf.js`
> (grid/list shelf with cover, rename, delete, practice), and the view switching in
> `src/main.js`. Per-book vocabulary stats live in the dashboard.

## 1. Context

Today the app holds a single "current document" in IndexedDB; loading a new file
replaces it. The user wants a **digital bookshelf**: keep multiple processed books
(e.g. the 7 Harry Potter books), see them on a shelf, and open any on demand —
without re-importing/re-extracting the PDF each time. Reading progress should be
remembered **per book**.

A secondary need is portability: move a processed book to another device (or back it
up) without re-running PDF extraction. That calls for a self-contained file format.

## 2. Goals

- A **library** of many books, persisted on-device (survives reloads).
- A **bookshelf view**: covers/titles; tap to open; remove a book.
- **Per-book reading progress** (resume each book where you left off).
- Reuse the existing ingest pipeline: a PDF is extracted **once**, then stored as a
  ready-to-read book (clean text + images), so reopening is instant.
- **Export/import a book** as a self-contained file to move/back it up.

## 3. Non-goals

- Cloud sync (separate future feature; file export covers manual backup for now).
- Editing book content.
- DRM / encryption.

## 4. On-device storage (the library)

Move from one "current" record to a **books** object store in IndexedDB.

```text
IndexedDB "immersive-reader"
  store "books"  (keyed by id)
    Book = {
      id: string                 // uuid
      title: string              // from file name or PDF metadata
      author?: string            // from PDF metadata if available
      addedAt: number
      text: string               // clean, normalized reading text
      images: { start, width, height, blob }[]   // anchored illustrations
      cover?: Blob               // thumbnail for the shelf (first image or generated)
      progressWordIndex: number  // per-book reading position
      lastOpenedAt?: number
    }
  store "meta"  (small values: e.g. lastOpenedBookId)
```

Notes:

- **Vocabulary stays global** (word → state, in localStorage) — it is shared across
  all books, which is the whole point of the tool. Only reading *position* is
  per-book.
- The definitions cache stays global too (keyed by word/context).
- A book record can be large (text + image Blobs); IndexedDB handles this. Blobs are
  stored directly (no base64).

## 5. Book file format (export/import): `.tir`

For carrying a processed book between devices. **Recommended: a ZIP container**
(extension `.tir`), because books contain binary images.

```text
book.tir  (zip)
  manifest.json   { format: "tir", version: 1, title, author, addedAt,
                    images: [{ file, start, width, height }] }
  text.txt        the clean reading text
  images/0.png …  the illustration blobs
  cover.png       optional shelf thumbnail
```

- Use a tiny zip lib (e.g. **fflate**, ~8KB) — JSZip works too but is heavier.
- Alternative considered: a single JSON with images as base64 data URLs. Rejected as
  the default — ~33% larger and memory-heavy for big illustrated books — but fine as
  a no-dependency fallback for image-free books.
- Import: unzip → reconstruct a Book record → add to the library. Export: zip a Book
  record. Reading position and vocabulary are NOT embedded (vocabulary is global;
  position is per-device/per-book and optional to include).

## 6. UI

- **Bookshelf** (home screen when no book is open): a grid of covers with titles;
  "+ Add book" (open file) and per-book actions (open, export, delete).
- Opening a book → the existing reader, restoring that book's `progressWordIndex`.
- A "back to shelf" control (in the ☰ menu or a corner).
- Empty state: prompt to add the first book.

```text
┌───────────────────────────────┐
│  My Library            [ + ]   │
│  ┌──────┐ ┌──────┐ ┌──────┐    │
│  │cover │ │cover │ │cover │    │
│  │  HP1 │ │  HP2 │ │  HP3 │    │
│  └──────┘ └──────┘ └──────┘    │
│  ┌──────┐ ┌──────┐             │
│  │  HP4 │ │  HP5 │   …          │
│  └──────┘ └──────┘             │
└───────────────────────────────┘
```

## 7. Migration

- Replace `session.js`'s single-document storage with the `books` store.
- On first run after upgrade: if an old `document.v2` record exists, convert it into
  one Book and open it. Bump the IndexedDB version with an `onupgradeneeded` migration.
- `saveProgress`/`loadProgress` become per-book (stored on the Book record), keyed by
  the open book's id.

## 8. Milestones

1. **Library store + bookshelf view**: books store, add/open/delete, per-book
   progress. (Cover = first extracted image, or a generated text thumbnail.)
2. **Migrate** the current single-document flow into the library.
3. **Export/import `.tir`** (zip via fflate).
4. Polish: PDF metadata for title/author, sorting, search, reading stats.

## 9. Open questions

- Cover when a book has no images: generate a simple text-based cover (title on a
  colored card)?
- Should export include reading position? (Default: no — keep files portable/shareable.)
- Storage limits: IndexedDB is large but not infinite; show total usage and allow
  deleting books to free space.
