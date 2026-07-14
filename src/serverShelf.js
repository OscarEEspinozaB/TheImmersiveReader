// Server Library view: browse the home server's book catalog, download any book
// into the local library, and BUILD a book's dictionary. Mirrors the local shelf's
// card layout (reusing the `.book` styles) so the two libraries feel like one place.
//
// Building used to be a terminal job on the home machine, which meant only the
// person sitting at it could grow the dictionary. Each card now shows how much of
// its book is already refined — in LEMMAS, the work that is actually left — and a
// button that asks the server to build the rest. One book at a time, stoppable, and
// what is built is kept: the server holds the truth, the app just watches.

import {
  listServerBooks, downloadServerBook, deleteServerBook, serverCoverUrl, isServerAvailable,
  bookCoverage, buildServerBook, buildStatus, stopBuild,
} from './serverLibrary.js';
import { confirmDialog, alertDialog } from './dialog.js';
import { readingLangName } from './settings.js';

const POLL_MS = 2000;

// The first coverage request for a book unzips it and segments its whole text, so
// the cards ask one at a time — a shelf of twenty books must not hit the server
// with twenty of those at once. (The server caches the result; later renders are
// instant.)
let coverageQueue = Promise.resolve();
function queueCoverage(fn) {
  coverageQueue = coverageQueue.then(fn).catch((err) => console.warn('coverage failed:', err));
}

// The cards of the current render, so the poller can find the one that is building.
let cards = new Map(); // bookId -> { setJob, refresh }
let poller = null;

function stopPolling() {
  if (poller) clearInterval(poller);
  poller = null;
}

// One poller for the whole view (not one per card): the server builds one book at a
// time, so there is exactly one thing to watch.
function startPolling() {
  stopPolling();
  poller = setInterval(async () => {
    const job = await buildStatus();
    for (const [id, card] of cards) card.setJob(job?.bookId === id ? job : null);
    // The job just ended: the finished book's coverage is now higher than the bar
    // says, so ask the server for the real number.
    if (!job) {
      stopPolling();
      for (const card of cards.values()) card.refresh();
    }
  }, POLL_MS);
}

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

  stopPolling();
  cards = new Map();
  for (const book of books) {
    container.appendChild(serverCard(book, container, onDownloaded));
  }

  // A build may already be running (started from another device, or before this
  // view was opened) — pick it up instead of pretending the server is idle.
  const running = await buildStatus();
  if (running) {
    for (const [id, card] of cards) card.setJob(running.bookId === id ? running : null);
    startPolling();
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

  // --- Dictionary coverage + the build button ---
  const build = document.createElement('div');
  build.className = 'book__build';

  const bar = document.createElement('div');
  bar.className = 'book__bar';
  const fill = document.createElement('span');
  bar.appendChild(fill);

  const label = document.createElement('span');
  label.className = 'book__build-label';
  label.textContent = 'Dictionary …';

  // The button belongs with the other per-book actions (download, remove), not
  // squeezed beside the bar: a grid card has no room for three things on one line,
  // and the label ("Dictionary 60% · 1,660 words left") is the part worth reading.
  const go = iconButton('Build this book\u2019s dictionary', 'M5 3l14 9-14 9z');
  go.hidden = true;

  build.append(label, bar);
  meta.appendChild(build);

  let coverageData = null;
  let jobData = null;

  const paint = () => {
    if (jobData) {
      // While it builds, the bar shows THIS job's progress: the words left in it are
      // the honest measure of the wait, not a percentage that barely moves.
      const pct = jobData.total ? Math.round((jobData.done / jobData.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      bar.classList.add('is-building');
      // A grid card is narrow: the line has to survive it. The word in flight is
      // interesting but not worth losing the count and the wait to — it lives in
      // the tooltip.
      const eta = jobData.etaMs ? ` · ~${Math.max(1, Math.round(jobData.etaMs / 60000))} min` : '';
      label.textContent = jobData.stopping
        ? `Stopping… ${jobData.done}/${jobData.total}`
        : `Building ${jobData.done.toLocaleString()}/${jobData.total.toLocaleString()}${eta}`;
      label.title = jobData.current ? `Building “${jobData.current}”…` : 'Building…';
      go.hidden = false;
      go.title = 'Stop building';
      go.classList.add('is-stop');
      return;
    }
    bar.classList.remove('is-building');
    go.classList.remove('is-stop');
    if (!coverageData) {
      fill.style.width = '0%';
      label.textContent = 'Dictionary —';
      go.hidden = true;
      return;
    }
    fill.style.width = `${coverageData.pct}%`;
    const done = coverageData.pending === 0;
    label.textContent = done
      ? `Dictionary complete · ${coverageData.total.toLocaleString()} words`
      : `${coverageData.pct}% · ${coverageData.pending.toLocaleString()} words left`;
    label.title =
      `Dictionary: ${coverageData.built.toLocaleString()} of ${coverageData.total.toLocaleString()} words built ` +
      `(from ${coverageData.words.toLocaleString()} unique words in the book — forms of the same word are one entry).`;
    go.hidden = done;
    go.title = `Build the ${coverageData.pending.toLocaleString()} words this book still needs`;
  };

  const refresh = () =>
    queueCoverage(async () => {
      coverageData = await bookCoverage(book.id);
      paint();
    });

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      if (jobData) {
        await stopBuild();
      } else {
        const r = await buildServerBook(book.id);
        jobData = r.status;
        startPolling();
      }
      paint();
    } catch (err) {
      await alertDialog(err.message);
    } finally {
      go.disabled = false;
    }
  });

  cards.set(book.id, {
    setJob: (job) => {
      jobData = job;
      paint();
    },
    refresh,
  });
  refresh();

  actions.append(go, dl, del);
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
