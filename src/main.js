// App entry point: a bookshelf (library) and a reader. On load you see the shelf;
// opening a book switches to the reader. Books (text + images) live in IndexedDB.

import { ingest } from './ingest/index.js';
import { tokenize } from './tokenizer.js';
import { load as loadVocabulary, exportVocabulary, importVocabulary, resetAll } from './vocabulary.js';
import { Paginator } from './reader/paginator.js';
import { Scroller } from './reader/scroller.js';
import { initTheme, setTheme, getTheme, THEMES } from './reader/theme.js';
import { attachMarking } from './marking.js';
import { buildSentenceLookup } from './sentences.js';
import { migrateVocabularyEntries, resetLearned } from './contractions.js';
import { renderShelf } from './shelf.js';
import { renderServerShelf } from './serverShelf.js';
import { initVocabSync, syncNow } from './vocabSync.js';
import { recolorWord } from './reader/render.js';
import { renderProgress, renderDictionary } from './dashboard.js';
import { buildDeck, uniqueWords } from './deck.js';
import { importTir } from './tir.js';
import { renderSwiper } from './swiper.js';
import { alertDialog, confirmDialog, selectDialog } from './dialog.js';
import {
  addBook,
  getBook,
  getBookContent,
  setBookLang,
  setProgress,
  touchOpened,
  migrateOldDocument,
} from './library.js';
import {
  LANGUAGES,
  getLanguage,
  setLanguage,
  READING_LANGUAGES,
  readingLangName,
  getReadingLang,
  setActiveReadingLang,
  getDefaultReadingLang,
  setDefaultReadingLang,
  getOllamaUrl,
  setOllamaUrl,
  getOllamaModel,
  setOllamaModel,
  getKbUrl,
  setKbUrl,
  getProfile,
  setProfile,
  SORT_OPTIONS,
  getSortBy,
  setSortBy,
  getReadingMode,
  setReadingMode,
} from './settings.js';

const reader = document.getElementById('reader');
const readerWrap = document.querySelector('.reader-wrap');
const pager = document.getElementById('pager');
const shelf = document.getElementById('shelf');
const shelfGrid = document.getElementById('shelf-grid');
const shelfButton = document.getElementById('shelf-button');
const dashboard = document.getElementById('dashboard');
const serverShelf = document.getElementById('server-shelf');
const serverShelfGrid = document.getElementById('server-shelf-grid');
const serverRefresh = document.getElementById('server-refresh');
const primaryNav = document.getElementById('primary-nav');
const navLibrary = document.getElementById('nav-library');
const navServer = document.getElementById('nav-server');
const navDictionary = document.getElementById('nav-dictionary');
const navProgress = document.getElementById('nav-progress');
const swiperEl = document.getElementById('swiper');
const addBookInput = document.getElementById('add-book');
const viewToggle = document.getElementById('view-toggle');
const sortSelect = document.getElementById('sort-select');
const readingModeSelect = document.getElementById('reading-mode-select');
const fileInput = document.getElementById('file-input');
const sampleButton = document.getElementById('sample-button');
const prevButton = document.getElementById('prev-page');
const nextButton = document.getElementById('next-page');
const pageIndicator = document.getElementById('page-indicator');
const menuToggle = document.getElementById('menu-toggle');
const menu = document.getElementById('menu');
const langSelect = document.getElementById('lang-select');
const readingLangSelect = document.getElementById('reading-lang-select');
const ollamaUrlInput = document.getElementById('ollama-url');
const ollamaModelInput = document.getElementById('ollama-model');
const kbUrlInput = document.getElementById('kb-url');
const profileInput = document.getElementById('profile-name');
const exportButton = document.getElementById('export-words');
const importInput = document.getElementById('import-words');
const resetButton = document.getElementById('reset-data');
const themeSwatches = document.getElementById('theme-swatches');

let paginator = null;
let currentBookId = null;
let currentContent = null; // {text, images} of the open book (to re-render on mode change)
let currentView = 'grid';

initTheme();
loadVocabulary();
// Re-map any vocabulary entries saved as whole contractions (e.g. "didn't") into
// their component lemmas, so the stats count separated words, not contractions.
migrateVocabularyEntries();
// Keep the vocabulary in sync with the home server (per profile). When the server
// pushes a change while a book is open, recolor that word in place.
initVocabSync({
  onRemoteApplied: (changes) => {
    if (readerWrap.hidden) return; // not reading — the next render picks it up
    const lang = getReadingLang();
    for (const c of changes) {
      if (c.lang === lang) recolorWord(reader, c.word, c.state);
    }
  },
});

// --- View switching: shelf / reader / dictionary / progress / swiper ---
function setView(view) {
  const reading = view === 'reader';
  // Tear down the swiper's key listener when leaving it.
  if (view !== 'swiper' && swiperEl._cleanup) {
    swiperEl._cleanup();
    swiperEl._cleanup = null;
  }
  shelf.hidden = view !== 'shelf';
  serverShelf.hidden = view !== 'server';
  dashboard.hidden = !(view === 'dictionary' || view === 'progress');
  swiperEl.hidden = view !== 'swiper';
  readerWrap.hidden = !reading;
  pager.hidden = !reading;
  shelfButton.hidden = !reading; // "back to library" only while reading

  // Primary nav: shown only on the hub views, hidden in the immersive ones.
  const hub = view === 'shelf' || view === 'server' || view === 'dictionary' || view === 'progress';
  document.body.classList.toggle('nav-hidden', !hub);
  navLibrary.classList.toggle('is-active', view === 'shelf');
  navServer.classList.toggle('is-active', view === 'server');
  navDictionary.classList.toggle('is-active', view === 'dictionary');
  navProgress.classList.toggle('is-active', view === 'progress');

  hasDocument = reading; // chrome auto-hide applies only in the reader
  if (reading) {
    showChrome();
  } else {
    document.body.classList.remove('chrome-hidden');
    clearTimeout(hideTimer);
  }
}

async function openSwiper(id) {
  setMenuOpen(false);
  const [book, content] = await Promise.all([getBook(id), getBookContent(id)]);
  if (!content) return;
  // Tokenization + word states are language-scoped: evaluate in the book's language.
  setActiveReadingLang(book?.lang || getDefaultReadingLang());
  const { cards, stats } = buildDeck(content.text, { limit: 50 });
  if (!cards.length) {
    alertDialog('No words to practice in this book yet.');
    return;
  }
  setView('swiper');
  renderSwiper(swiperEl, { deck: cards, stats, onExit: showShelf });
}

function showProgress() {
  setMenuOpen(false);
  setView('progress');
  renderProgress(dashboard, { onOpenDictionary: showDictionary });
}

function showDictionary(filter) {
  setMenuOpen(false);
  setView('dictionary');
  renderDictionary(dashboard, { filter });
}

function renderLibrary() {
  return renderShelf(shelfGrid, {
    view: currentView,
    sortBy: getSortBy(),
    onOpen: openBook,
    onPractice: openSwiper,
  });
}

async function showShelf() {
  setMenuOpen(false);
  currentBookId = null;
  readingLangSelect.value = getDefaultReadingLang(); // no book open → edits the default
  setView('shelf');
  await renderLibrary();
}

async function showServerLibrary() {
  setMenuOpen(false);
  setView('server');
  // After a download lands in the local library, refresh the local shelf so it is
  // up to date the next time the user switches back to it.
  await renderServerShelf(serverShelfGrid, { onDownloaded: renderLibrary });
}

/** Ask the user to pick a reading language. @returns {Promise<string|null>} */
function pickReadingLang(message, defaultCode) {
  return selectDialog(
    message,
    READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
    defaultCode,
  );
}

async function openBook(id) {
  const [book, content] = await Promise.all([getBook(id), getBookContent(id)]);
  if (!content) return;
  // Older books have no language; ask once and persist it before rendering.
  let lang = book?.lang;
  if (!lang) {
    lang = (await pickReadingLang('What language is this book in?', getDefaultReadingLang())) || getDefaultReadingLang();
    await setBookLang(id, lang);
  }
  setActiveReadingLang(lang);
  readingLangSelect.value = lang;
  currentBookId = id;
  setView('reader');
  showDocument(content, { restoreIndex: book?.progressWordIndex || 0 });
  touchOpened(id);
}

async function addBookFromFile(file) {
  if (!file) return;
  setMenuOpen(false);

  // A `.tir` is an already-processed book: import it directly (its language comes
  // from the manifest, so there is no extraction step and no language prompt).
  if (/\.tir$/i.test(file.name)) {
    setView('reader');
    reader.innerHTML = '<p class="reader__placeholder">Importing…</p>';
    try {
      const { id } = await importTir(file);
      const book = await getBook(id);
      setActiveReadingLang(book?.lang || getDefaultReadingLang());
      await openBook(id);
    } catch (err) {
      console.error(err);
      reader.innerHTML = `<p class="reader__placeholder">Could not import this .tir: ${err.message}</p>`;
    }
    return;
  }

  const lang = (await pickReadingLang('What language is this book in?', getDefaultReadingLang())) || getDefaultReadingLang();
  setActiveReadingLang(lang);
  setView('reader');
  reader.innerHTML = '<p class="reader__placeholder">Loading…</p>';
  try {
    const { text, images } = await ingest(file);
    const cover = images[0]?.blob || null;
    const title = file.name.replace(/\.[^.]+$/, '');
    const id = await addBook({ title, text, images, cover, words: uniqueWords(text), lang });
    await openBook(id);
  } catch (err) {
    console.error(err);
    reader.innerHTML = `<p class="reader__placeholder">Could not read this file: ${err.message}</p>`;
  }
}

// --- Floating menu ---
function setMenuOpen(open) {
  menu.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  if (open) showChrome();
}
menuToggle.addEventListener('click', () => setMenuOpen(menu.hidden));
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !menuToggle.contains(e.target)) {
    setMenuOpen(false);
  }
});

// --- Auto-hiding chrome (top bar + pager), only while reading ---
const HIDE_DELAY = 2500;
let hasDocument = false;
let hideTimer = null;

function hideChrome() {
  if (!hasDocument || !menu.hidden) return;
  document.body.classList.add('chrome-hidden');
}

function showChrome() {
  document.body.classList.remove('chrome-hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideChrome, HIDE_DELAY);
}

document.addEventListener('pointermove', showChrome);
document.addEventListener('pointerdown', showChrome);
document.addEventListener('keydown', showChrome);

// --- Native language selector ---
for (const name of LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  langSelect.appendChild(opt);
}
langSelect.value = getLanguage();
langSelect.addEventListener('change', () => {
  setLanguage(langSelect.value);
  applyRedSeaSuppression(); // native language drives red-sea suppression
});

// --- Reading (book) language selector ---
// While a book is open it edits THAT book's language (and re-renders it); on the
// shelf it edits the default language used for newly added books.
for (const { code, name } of READING_LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  readingLangSelect.appendChild(opt);
}
readingLangSelect.value = getDefaultReadingLang();
readingLangSelect.addEventListener('change', async () => {
  const code = readingLangSelect.value;
  if (currentBookId && !readerWrap.hidden) {
    await setBookLang(currentBookId, code);
    setActiveReadingLang(code);
    if (currentContent) {
      const at = paginator ? paginator.currentFirstWordIndex() : 0;
      showDocument(currentContent, { restoreIndex: at });
    }
  } else {
    setDefaultReadingLang(code);
  }
});

// --- Ollama server config ---
ollamaUrlInput.value = getOllamaUrl();
ollamaUrlInput.addEventListener('change', () => setOllamaUrl(ollamaUrlInput.value));
ollamaModelInput.value = getOllamaModel();
ollamaModelInput.addEventListener('change', () => setOllamaModel(ollamaModelInput.value));
kbUrlInput.value = getKbUrl();
kbUrlInput.addEventListener('change', () => setKbUrl(kbUrlInput.value));

profileInput.value = getProfile();
profileInput.addEventListener('change', () => {
  setProfile(profileInput.value);
  syncNow(); // adopt the new profile: push local state, pull that profile's progress
});

// --- Vocabulary backup (export / import to a file) ---
exportButton.addEventListener('click', () => {
  setMenuOpen(false);
  const blob = new Blob([JSON.stringify(exportVocabulary(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `immersive-reader-words-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const applied = importVocabulary(data);
    paginator?.refresh();
    alertDialog(`Imported ${applied} words.`);
  } catch (err) {
    console.error(err);
    alertDialog(`Could not import: ${err.message}`);
  } finally {
    importInput.value = '';
    setMenuOpen(false);
  }
});

// --- Reset all vocabulary + learned dictionary (books are kept) ---
resetButton.addEventListener('click', async () => {
  setMenuOpen(false);
  const ok = await confirmDialog('Reset all vocabulary and the learned dictionary? Your books are kept.', {
    confirmLabel: 'Reset',
    danger: true,
  });
  if (!ok) return;
  resetAll();
  resetLearned();
  paginator?.refresh();
  if (!shelf.hidden) await renderLibrary();
  alertDialog('Vocabulary and dictionary reset.');
});

// --- Theme palette swatches ---
function renderSwatches() {
  themeSwatches.replaceChildren();
  for (const t of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.title = t.label;
    btn.style.background = t.bg;
    btn.setAttribute('aria-label', t.label);
    btn.classList.toggle('is-selected', t.id === getTheme());
    for (const color of [t.unknown, t.learning, t.known]) {
      const dot = document.createElement('span');
      dot.className = 'swatch__dot';
      dot.style.background = color;
      btn.appendChild(dot);
    }
    btn.addEventListener('click', () => {
      setTheme(t.id);
      renderSwatches();
    });
    themeSwatches.appendChild(btn);
  }
}
renderSwatches();

/**
 * Render a document (text + optional images) in the reader.
 * @param {{ text: string, images?: any[] }} doc
 * @param {{ restoreIndex?: number }} [opts]
 */
// The "red sea" is suppressed when the open book is written in the user's native
// language (they already know it): unknown words are no longer painted red. Marking
// still works — only the coloring is hidden (see .reader--no-red-sea in the CSS).
function applyRedSeaSuppression() {
  const suppress = readingLangName(getReadingLang()) === getLanguage();
  reader.classList.toggle('reader--no-red-sea', suppress);
}

function showDocument({ text, images = [] }, { restoreIndex = 0 } = {}) {
  if (paginator) paginator.destroy();
  currentContent = { text, images };
  applyRedSeaSuppression();

  const continuous = getReadingMode() === 'continuous';
  reader.classList.toggle('reader--scroll', continuous);
  pager.hidden = continuous; // no page buttons in continuous mode

  const tokens = tokenize(text);
  const Reader = continuous ? Scroller : Paginator;
  paginator = new Reader(reader, tokens, images);
  attachMarking(paginator.content, { getSentence: buildSentenceLookup(text, tokens) });

  // Restore the saved position BEFORE wiring progress-saving, so the first event
  // reports the restored spot (not the top, which would overwrite it).
  if (restoreIndex > 0) paginator.goToWordIndex(restoreIndex);

  paginator.onChange(({ pct, atStart, atEnd }) => {
    pageIndicator.textContent = `${pct}%`;
    prevButton.disabled = atStart;
    nextButton.disabled = atEnd;
    if (currentBookId) setProgress(currentBookId, paginator.currentFirstWordIndex());
  });
  showChrome();
}

// --- Shelf / add-book wiring ---
shelfButton.addEventListener('click', showShelf);
navLibrary.addEventListener('click', showShelf);
navServer.addEventListener('click', showServerLibrary);
navDictionary.addEventListener('click', () => showDictionary());
navProgress.addEventListener('click', showProgress);
serverRefresh.addEventListener('click', () =>
  renderServerShelf(serverShelfGrid, { onDownloaded: renderLibrary }),
);
viewToggle.addEventListener('click', () => {
  currentView = currentView === 'grid' ? 'list' : 'grid';
  renderLibrary();
});

for (const { value, label } of SORT_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  sortSelect.appendChild(opt);
}
sortSelect.value = getSortBy();
sortSelect.addEventListener('change', () => {
  setSortBy(sortSelect.value);
  renderLibrary();
});

// Reading mode (paged vs continuous): re-render the open book at the same spot.
readingModeSelect.value = getReadingMode();
readingModeSelect.addEventListener('change', () => {
  setReadingMode(readingModeSelect.value);
  if (currentContent && !readerWrap.hidden) {
    const at = paginator ? paginator.currentFirstWordIndex() : 0;
    showDocument(currentContent, { restoreIndex: at });
  }
});
addBookInput.addEventListener('change', (e) => addBookFromFile(e.target.files[0]));
fileInput.addEventListener('change', (e) => addBookFromFile(e.target.files[0]));

sampleButton.addEventListener('click', async () => {
  setMenuOpen(false);
  const res = await fetch(`${import.meta.env.BASE_URL}sample/sample.txt`);
  const text = await res.text();
  setActiveReadingLang('en'); // the sample (Alice in Wonderland) is English
  const id = await addBook({
    title: 'Sample — Alice in Wonderland',
    text,
    images: [],
    cover: null,
    words: uniqueWords(text),
    lang: 'en',
  });
  await openBook(id);
});

// --- Startup: migrate any old single document, then show the shelf ---
migrateOldDocument()
  .catch(() => {})
  .finally(showShelf);

// --- Page navigation ---
prevButton.addEventListener('click', () => paginator?.prev());
nextButton.addEventListener('click', () => paginator?.next());

document.addEventListener('keydown', (e) => {
  if (!paginator || readerWrap.hidden) return;
  if (e.key === 'ArrowLeft') paginator.prev();
  else if (e.key === 'ArrowRight') paginator.next();
});

// Touch swipe: horizontal drag turns the page (left = next, right = prev).
const SWIPE_THRESHOLD = 50;
let touchStartX = 0;
let touchStartY = 0;
let tracking = false;

reader.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    tracking = true;
  },
  { passive: true },
);

reader.addEventListener(
  'touchend',
  (e) => {
    if (!tracking || !paginator) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) paginator.next();
      else paginator.prev();
    }
  },
  { passive: true },
);
