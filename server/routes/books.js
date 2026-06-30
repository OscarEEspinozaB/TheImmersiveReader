// The home library book store (LAN, no accounts).
//
//   GET    /books?lang=&q=    -> catalog metadata (filtered)
//   POST   /books             -> upload a .tir (raw octet-stream body)
//   GET    /books/:id         -> one book's metadata
//   GET    /books/:id/content -> the .tir payload (download)
//   GET    /books/:id/cover   -> the cover image
//   DELETE /books/:id         -> remove a book (metadata + files)
//
// The client builds the `.tir` (src/tir.js) and POSTs the bytes directly; the
// server reads metadata (title, lang, cover) from the archive's manifest.json with
// fflate — the same format on both sides — so no separate metadata payload is
// needed. Books are immutable once uploaded; a re-upload of identical bytes is a
// no-op (deduped by sha256).

import express, { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { getLibraryDb, BOOKS_DIR } from '../library-db.js';

export const booksRouter = Router();

const tirPath = (id) => join(BOOKS_DIR, `${id}.tir`);
const coverPath = (id) => join(BOOKS_DIR, `${id}.cover`);

// A book row -> the JSON shape the client expects.
function toCatalog(r) {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    lang: r.lang,
    size: r.size,
    hasCover: !!r.cover_mime,
    addedAt: r.book_added_at,
    uploadedAt: r.uploaded_at,
  };
}

booksRouter.get('/books', (req, res) => {
  const lang = req.query.lang ? String(req.query.lang) : null;
  const q = String(req.query.q || '').trim().toLowerCase();

  const db = getLibraryDb();
  let where = '1=1';
  const params = [];
  if (lang) {
    where += ' AND lang = ?';
    params.push(lang);
  }
  if (q) {
    where += ' AND lower(title) LIKE ?';
    params.push(`%${q}%`);
  }
  const rows = db
    .prepare(`SELECT * FROM books WHERE ${where} ORDER BY title COLLATE NOCASE ASC`)
    .all(...params);
  res.json({ total: rows.length, books: rows.map(toCatalog) });
});

// Raw upload: the body IS the .tir archive. Mounted only on this route so the
// global express.json() parser is untouched.
booksRouter.post(
  '/books',
  express.raw({ type: () => true, limit: '300mb' }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'Empty body; POST the raw .tir bytes.' });
    }

    let files;
    let manifest;
    try {
      files = unzipSync(new Uint8Array(buf));
      manifest = JSON.parse(strFromU8(files['manifest.json']));
    } catch {
      return res.status(400).json({ error: 'Not a valid .tir archive.' });
    }
    if (manifest.format !== 'tir') {
      return res.status(400).json({ error: 'Not a .tir book (bad manifest).' });
    }

    const db = getLibraryDb();
    const sha = createHash('sha256').update(buf).digest('hex');
    const bookUid = typeof manifest.id === 'string' ? manifest.id : null;

    // Dedup by the book's stable id (so a re-export with different bytes is still
    // the same book); fall back to the content hash for legacy files without an id.
    const existing = bookUid
      ? db.prepare('SELECT id, title FROM books WHERE book_uid = ?').get(bookUid)
      : db.prepare('SELECT id, title FROM books WHERE sha = ?').get(sha);
    if (existing) {
      return res.json({ id: existing.id, title: existing.title, duplicate: true });
    }

    const id = randomUUID();
    writeFileSync(tirPath(id), buf);

    let coverMime = null;
    if (manifest.cover && files[manifest.cover]) {
      coverMime = manifest.coverMime || 'image/png';
      writeFileSync(coverPath(id), Buffer.from(files[manifest.cover]));
    }

    db.prepare(
      `INSERT INTO books (id, book_uid, sha, title, author, lang, size, cover_mime, book_added_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      bookUid,
      sha,
      manifest.title || 'Untitled',
      manifest.author || null,
      manifest.lang || null,
      buf.length,
      coverMime,
      manifest.addedAt || null,
      Date.now(),
    );

    res.status(201).json({ id, title: manifest.title || 'Untitled' });
  },
);

booksRouter.get('/books/:id', (req, res) => {
  const row = getLibraryDb().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(toCatalog(row));
});

booksRouter.get('/books/:id/content', (req, res) => {
  const row = getLibraryDb().prepare('SELECT title FROM books WHERE id = ?').get(req.params.id);
  const path = tirPath(req.params.id);
  if (!row || !existsSync(path)) return res.status(404).json({ error: 'Not found' });
  // HTTP headers are ASCII-only, so titles with non-ASCII (e.g. an em-dash) need an
  // ASCII fallback plus an RFC 5987 UTF-8 form.
  const safe = `${(row.title || 'book').replace(/[\\/:*?"<>|]+/g, '_')}.tir`;
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
  );
  createReadStream(path).pipe(res);
});

booksRouter.get('/books/:id/cover', (req, res) => {
  const row = getLibraryDb().prepare('SELECT cover_mime FROM books WHERE id = ?').get(req.params.id);
  const path = coverPath(req.params.id);
  if (!row || !row.cover_mime || !existsSync(path)) return res.status(404).end();
  res.setHeader('Content-Type', row.cover_mime);
  res.setHeader('Cache-Control', 'max-age=86400');
  res.send(readFileSync(path));
});

booksRouter.delete('/books/:id', (req, res) => {
  const db = getLibraryDb();
  const row = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  for (const p of [tirPath(req.params.id), coverPath(req.params.id)]) {
    if (existsSync(p)) unlinkSync(p);
  }
  res.json({ ok: true });
});
