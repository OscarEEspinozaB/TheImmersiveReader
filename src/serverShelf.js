// Server Library view: browse the home server's book catalog and download any
// book into the local library. Mirrors the local shelf's card layout (reusing the
// `.book` styles) so the two libraries feel like one place.

import { listServerBooks, downloadServerBook, deleteServerBook, serverCoverUrl, isServerAvailable } from './serverLibrary.js';
import { confirmDialog, alertDialog } from './dialog.js';
import { readingLangName } from './settings.js';

/**
 * @param {HTMLElement} container
 * @param {{ onDownloaded?: () => void }} [opts]
 */
export async function renderServerShelf(container, { onDownloaded } = {}) {
  container.replaceChildren();
  container.dataset.view = 'grid';

  const reachable = await isServerAvailable();
  if (!reachable) {
    container.appendChild(
      notice('The home server is not reachable. Set the “Home server URL” in settings and make sure it is running.'),
    );
    return;
  }

  const books = await listServerBooks();
  if (books.length === 0) {
    container.appendChild(notice('No books on the server yet. Upload one from your library (the ☁ button).'));
    return;
  }

  for (const book of books) {
    container.appendChild(serverCard(book, container, onDownloaded));
  }
}

function serverCard(book, container, onDownloaded) {
  const reRender = () => renderServerShelf(container, { onDownloaded });
  const card = document.createElement('div');
  card.className = 'book';

  const download = async () => {
    try {
      const r = await downloadServerBook(book.id);
      await alertDialog(
        r.duplicate
          ? `"${book.title}" is already in your library.`
          : `"${book.title}" was added to your library.`,
      );
      if (!r.duplicate) onDownloaded?.();
    } catch (err) {
      console.error(err);
      await alertDialog(`Could not download: ${err.message}`);
    }
  };

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'book__cover';
  cover.title = `Download “${book.title}”`;
  cover.addEventListener('click', download);
  if (book.hasCover) {
    const img = document.createElement('img');
    img.src = serverCoverUrl(book.id);
    img.alt = '';
    cover.appendChild(img);
  } else {
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
  title.addEventListener('click', download);
  meta.appendChild(title);

  const sub = document.createElement('span');
  sub.className = 'book__sub';
  const lang = book.lang ? readingLangName(book.lang) : '—';
  sub.textContent = `${lang} · ${formatSize(book.size)}`;
  meta.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'book__actions';

  const dl = iconButton('Download to my library', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3');
  dl.addEventListener('click', download);

  const del = iconButton('Remove from server', 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6');
  del.addEventListener('click', async () => {
    const ok = await confirmDialog(`Remove "${book.title}" from the server library? Local copies are kept.`, {
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteServerBook(book.id);
      reRender();
    } catch (err) {
      console.error(err);
      await alertDialog(`Could not remove: ${err.message}`);
    }
  });

  actions.append(dl, del);
  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

function notice(text) {
  const p = document.createElement('p');
  p.className = 'shelf__empty';
  p.textContent = text;
  return p;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
