// Bookshelf view: renders the library as a grid or list of books (cover + title),
// with open / rename / delete actions. Opening is delegated to the caller.
// Each card also shows a COMPREHENSIBILITY verdict — how much of the book's
// running text is still NEW (not marked known) — so the reader can pick material
// at the right level: extensive reading is comfortable under ~5% new words.

import {
  listBooks, renameBook, deleteBook, setBookLang,
  getBookWordData, setBookWords, getBookContent,
} from './library.js';
import { confirmDialog, promptDialog, selectDialog, alertDialog } from './dialog.js';
import {
  READING_LANGUAGES, readingLangName,
  getLanguage, getReadingLang, setActiveReadingLang,
} from './settings.js';
import { listEntries } from './vocabulary.js';
import { bookWordData } from './deck.js';
import { exportBookToBlob } from './tir.js';
import { uploadBook } from './serverLibrary.js';

let coverUrls = []; // object URLs for the current render, revoked on re-render

const sorters = {
  lastRead: (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  title: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
};

/**
 * @param {HTMLElement} container
 * @param {{ view: 'grid'|'list', sortBy?: string, onOpen: (id: string) => void }} opts
 */
export async function renderShelf(container, { view, sortBy = 'lastRead', onOpen, onPractice }) {
  for (const url of coverUrls) URL.revokeObjectURL(url);
  coverUrls = [];

  const books = await listBooks();
  books.sort(sorters[sortBy] || sorters.lastRead);
  container.dataset.view = view;
  container.replaceChildren();

  if (books.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'shelf__empty';
    empty.textContent = 'Your library is empty. Add a .txt, .md or .pdf to begin.';
    container.appendChild(empty);
    return;
  }

  for (const book of books) {
    container.appendChild(bookCard(book, container, { view, sortBy, onOpen, onPractice }));
  }
}

function bookCard(book, container, opts) {
  const { view, onOpen, onPractice } = opts;
  const reRender = () => renderShelf(container, opts);
  const card = document.createElement('div');
  card.className = 'book';

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'book__cover';
  cover.title = book.title;
  cover.addEventListener('click', () => onOpen(book.id));
  if (book.cover) {
    const url = URL.createObjectURL(book.cover);
    coverUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    cover.appendChild(img);
  } else {
    // Generated text cover when the book has no image.
    const gen = document.createElement('span');
    gen.className = 'book__cover-text';
    gen.textContent = book.title;
    cover.appendChild(gen);
  }
  card.appendChild(cover);

  const meta = document.createElement('div');
  meta.className = 'book__meta';

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'book__title';
  title.textContent = book.title;
  title.addEventListener('click', () => onOpen(book.id));
  meta.appendChild(title);

  // Comprehensibility score, filled in asynchronously (may tokenize the book once).
  const coverage = document.createElement('div');
  coverage.className = 'book__coverage';
  coverage.hidden = true;
  meta.appendChild(coverage);
  queueCoverage(() => fillCoverage(book, coverage));

  const actions = document.createElement('div');
  actions.className = 'book__actions';

  const practice = iconButton('Practice words', 'M5 3l14 9-14 9z');
  practice.addEventListener('click', () => onPractice?.(book.id));

  const langLabel = book.lang ? readingLangName(book.lang) : 'not set';
  const lang = iconButton(
    `Language: ${langLabel}`,
    'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20 M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  );
  lang.addEventListener('click', async () => {
    const code = await selectDialog(
      'Book language:',
      READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
      book.lang || READING_LANGUAGES[0].code,
    );
    if (code) {
      await setBookLang(book.id, code);
      reRender();
    }
  });

  const exportBtn = iconButton(
    'Export as .tir',
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  );
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const { blob, filename } = await exportBookToBlob(book.id);
      downloadBlob(blob, filename);
    } catch (err) {
      console.error(err);
      await alertDialog(`Could not export this book: ${err.message}`);
    } finally {
      exportBtn.disabled = false;
    }
  });

  const upload = iconButton(
    'Upload to server',
    'M12 12v9 M8 16l4-4 4 4 M20 16.7A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 15.2',
  );
  upload.addEventListener('click', async () => {
    upload.disabled = true;
    try {
      const r = await uploadBook(book.id);
      await alertDialog(
        r.duplicate
          ? `"${r.title}" is already in the server library.`
          : `"${r.title}" was uploaded to the server library.`,
      );
    } catch (err) {
      console.error(err);
      await alertDialog(`Could not upload: ${err.message}`);
    } finally {
      upload.disabled = false;
    }
  });

  const rename = iconButton('Rename', 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z');
  rename.addEventListener('click', async () => {
    const name = await promptDialog('Book title:', book.title);
    if (name) {
      await renameBook(book.id, name);
      reRender();
    }
  });

  const del = iconButton('Delete', 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6');
  del.addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete "${book.title}"? Your vocabulary is kept.`, {
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) {
      await deleteBook(book.id);
      reRender();
    }
  });

  // Keep the card uncluttered: only "Read" is always visible; everything else
  // (practice, language, export, upload, rename, delete) lives behind a "⋮" menu.
  const read = iconButton('Read', 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z');
  read.addEventListener('click', () => onOpen(book.id));

  const more = document.createElement('div');
  more.className = 'book__more';
  more.hidden = true;
  more.append(practice, lang, exportBtn, upload, rename, del);

  const moreWrap = document.createElement('div');
  moreWrap.className = 'book__more-wrap';
  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'book__action book__kebab';
  kebab.title = 'More actions';
  kebab.setAttribute('aria-label', 'More actions');
  kebab.textContent = '⋮';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = more.hidden;
    document.querySelectorAll('.book__more').forEach((m) => { m.hidden = true; }); // close others
    more.hidden = !willOpen;
    if (more.hidden) return;
    // The menu is wider than a grid card and the shelf scroll container clips
    // absolutely-positioned overflow, so position it FIXED next to the kebab,
    // clamped inside the viewport (above the button, or below if there's no room).
    const r = kebab.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(r.right - more.offsetWidth, window.innerWidth - more.offsetWidth - margin));
    let top = r.top - more.offsetHeight - 4;
    if (top < margin) top = r.bottom + 4;
    more.style.left = `${left}px`;
    more.style.top = `${top}px`;
    const onDocClick = (ev) => {
      if (!moreWrap.contains(ev.target)) {
        more.hidden = true;
        document.removeEventListener('click', onDocClick);
      }
    };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  });
  moreWrap.append(kebab, more);

  actions.append(read, moreWrap);
  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

// --- Readability badge ------------------------------------------------------------
// "How much of this BOOK can I actually read?" — measured in units of READING,
// not word statistics: a sentence is readable only when EVERY word in it is
// marked known (discarded/exempt words — proper nouns, code… — count as known),
// and the badge is the share of the book's sentences that pass.
// Word-based framings were tried and rejected three times ("% known",
// token-weighted "new", unique-word "new") — all disagreed with the owner's
// lived reality of opening the book. This is the hard truth by construction:
// with a fresh vocabulary it says 0%, exactly like the first page feels.
// Legacy books without stored sentence data are tokenized once, in a sequential
// queue, then cached.

let coverageQueue = Promise.resolve();
function queueCoverage(fn) {
  coverageQueue = coverageQueue.then(fn).catch((err) => console.warn('readability failed:', err));
}

async function fillCoverage(book, badge) {
  if (!badge.isConnected) return; // the shelf re-rendered while queued
  // A book in the user's native language has no red sea — a score is meaningless.
  if (!book.lang || readingLangName(book.lang) === getLanguage()) return;

  let rec = await getBookWordData(book.id);
  if (!rec) {
    const content = await getBookContent(book.id);
    if (!content?.text) return;
    // tokenize() follows the ACTIVE reading language; point it at this book's
    // language for the (synchronous) pass, then restore it.
    const prev = getReadingLang();
    setActiveReadingLang(book.lang);
    try {
      rec = bookWordData(content.text);
    } finally {
      setActiveReadingLang(prev);
    }
    await setBookWords(book.id, rec);
  }
  if (!rec.sentences?.length || !badge.isConnected) return;

  const state = new Map(listEntries(book.lang).map((e) => [e.word, e.state]));
  let readable = 0;
  for (const sentence of rec.sentences) {
    let ok = true;
    for (const wi of sentence) {
      // Discarded words are exempt (proper nouns, code…): they never count against
      // readability, otherwise a book full of character names could never read as
      // "readable" even once you understand the language.
      const st = state.get(rec.words[wi]);
      if (st !== 'known' && st !== 'discarded') {
        ok = false;
        break;
      }
    }
    if (ok) readable += 1;
  }

  const total = rec.sentences.length;
  // Floor: the book must never look more readable than it is.
  const pct = Math.floor((readable / total) * 100);
  const band = pct >= 90 ? 'ideal' : pct >= 50 ? 'ok' : 'hard';
  badge.textContent = `You can read ${pct}%`;
  badge.title =
    `${readable.toLocaleString()} of this book's ${total.toLocaleString()} sentences are fully ` +
    `readable right now — sentences where you know every single word. ` +
    `Marking words as known raises this.`;
  badge.classList.add(`book__coverage--${band}`);
  badge.hidden = false;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function iconButton(label, path) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'book__action';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path
    .split(' M')
    .map((d, i) => `<path d="${i ? 'M' : ''}${d}" />`)
    .join('')}</svg>`;
  return btn;
}
