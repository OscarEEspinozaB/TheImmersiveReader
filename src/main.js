// App entry point: a bookshelf (library) and a reader. On load you see the shelf;
// opening a book switches to the reader. Books (text + images) live in IndexedDB.

import { ingest } from './ingest/index.js';
import { tokenize } from './tokenizer.js';
import { load as loadVocabulary, exportVocabulary, importVocabulary } from './vocabulary.js';
import { Paginator } from './reader/paginator.js';
import { Scroller } from './reader/scroller.js';
import { initTheme, setTheme, getTheme, THEMES } from './reader/theme.js';
import { attachMarking } from './marking.js';
import { buildSentenceLookup } from './sentences.js';
import { renderShelf } from './shelf.js';
import { renderDashboard } from './dashboard.js';
import { buildDeck, uniqueWords } from './deck.js';
import { renderSwiper } from './swiper.js';
import { alertDialog } from './dialog.js';
import {
  addBook,
  getBook,
  getBookContent,
  setProgress,
  touchOpened,
  migrateOldDocument,
} from './library.js';
import {
  LANGUAGES,
  getLanguage,
  setLanguage,
  READING_LANGUAGES,
  getReadingLang,
  setReadingLang,
  getOllamaUrl,
  setOllamaUrl,
  getOllamaModel,
  setOllamaModel,
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
const vocabButton = document.getElementById('vocab-button');
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
const exportButton = document.getElementById('export-words');
const importInput = document.getElementById('import-words');
const themeSwatches = document.getElementById('theme-swatches');

let paginator = null;
let currentBookId = null;
let currentContent = null; // {text, images} of the open book (to re-render on mode change)
let currentView = 'grid';

initTheme();
loadVocabulary();

// --- View switching: shelf / reader / vocabulary ---
function setView(view) {
  const reading = view === 'reader';
  // Tear down the swiper's key listener when leaving it.
  if (view !== 'swiper' && swiperEl._cleanup) {
    swiperEl._cleanup();
    swiperEl._cleanup = null;
  }
  shelf.hidden = view !== 'shelf';
  dashboard.hidden = view !== 'vocabulary';
  swiperEl.hidden = view !== 'swiper';
  readerWrap.hidden = !reading;
  pager.hidden = !reading;
  shelfButton.hidden = !reading; // "back to library" only while reading
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
  const content = await getBookContent(id);
  if (!content) return;
  const { cards, stats } = buildDeck(content.text, { limit: 50 });
  if (!cards.length) {
    alertDialog('No words to practice in this book yet.');
    return;
  }
  setView('swiper');
  renderSwiper(swiperEl, { deck: cards, stats, onExit: showShelf });
}

function showDashboard() {
  setMenuOpen(false);
  setView('vocabulary');
  renderDashboard(dashboard, { onBack: showShelf });
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
  setView('shelf');
  await renderLibrary();
}

async function openBook(id) {
  const [book, content] = await Promise.all([getBook(id), getBookContent(id)]);
  if (!content) return;
  currentBookId = id;
  setView('reader');
  showDocument(content, { restoreIndex: book?.progressWordIndex || 0 });
  touchOpened(id);
}

async function addBookFromFile(file) {
  if (!file) return;
  setMenuOpen(false);
  setView('reader');
  reader.innerHTML = '<p class="reader__placeholder">Loading…</p>';
  try {
    const { text, images } = await ingest(file);
    const cover = images[0]?.blob || null;
    const title = file.name.replace(/\.[^.]+$/, '');
    const id = await addBook({ title, text, images, cover, words: uniqueWords(text) });
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
langSelect.addEventListener('change', () => setLanguage(langSelect.value));

// --- Reading (book) language selector ---
for (const { code, name } of READING_LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  readingLangSelect.appendChild(opt);
}
readingLangSelect.value = getReadingLang();
readingLangSelect.addEventListener('change', () => setReadingLang(readingLangSelect.value));

// --- Ollama server config ---
ollamaUrlInput.value = getOllamaUrl();
ollamaUrlInput.addEventListener('change', () => setOllamaUrl(ollamaUrlInput.value));
ollamaModelInput.value = getOllamaModel();
ollamaModelInput.addEventListener('change', () => setOllamaModel(ollamaModelInput.value));

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
function showDocument({ text, images = [] }, { restoreIndex = 0 } = {}) {
  if (paginator) paginator.destroy();
  currentContent = { text, images };

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
vocabButton.addEventListener('click', showDashboard);
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
  const id = await addBook({ title: 'Sample — Alice in Wonderland', text, images: [], cover: null, words: uniqueWords(text) });
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
