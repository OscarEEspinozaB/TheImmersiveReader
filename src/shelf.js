// Bookshelf view: renders the library as a grid or list of books (cover + title),
// with open / rename / delete actions. Opening is delegated to the caller.

import { listBooks, renameBook, deleteBook } from './library.js';
import { confirmDialog, promptDialog } from './dialog.js';

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
export async function renderShelf(container, { view, sortBy = 'lastRead', onOpen }) {
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
    container.appendChild(bookCard(book, container, { view, sortBy, onOpen }));
  }
}

function bookCard(book, container, opts) {
  const { view, onOpen } = opts;
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

  const actions = document.createElement('div');
  actions.className = 'book__actions';

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

  actions.append(rename, del);
  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
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
