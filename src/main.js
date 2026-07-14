// App entry point: a bookshelf (library) and a reader. On load you see the shelf;
// opening a book switches to the reader. Books (text + images) live in IndexedDB.

import { ingest } from './ingest/index.js';
import { tokenize } from './tokenizer.js';
import { load as loadVocabulary, exportVocabulary, importVocabulary, resetAll } from './vocabulary.js';
import '@fontsource-variable/literata/wght.css'; // self-hosted reader font (offline)
import { Paginator } from './reader/paginator.js';
import { Scroller } from './reader/scroller.js';
import { attachPageTurn } from './reader/pageTurn.js';
import { initTheme, setTheme, getTheme, THEMES } from './reader/theme.js';
import { attachMarking } from './marking.js';
import { buildSentenceLookup, buildParagraphLookup } from './sentences.js';
import { migrateVocabularyEntries, resetLearned } from './contractions.js';
import { renderShelf } from './shelf.js';
import { renderServerShelf } from './serverShelf.js';
import { initVocabSync, syncNow } from './vocabSync.js';
import { recolorWord } from './reader/render.js';
import { renderProgress, renderDictionary } from './dashboard.js';
import { buildDeck, bookWordData } from './deck.js';
import { importTir } from './tir.js';
import { prepareCover, documentCover, imagesWithCover } from './cover.js';
import { renderSwiper } from './swiper.js';
import { alertDialog, confirmDialog, selectDialog } from './dialog.js';
import { listAiModels } from './definitions/index.js';
import { canSpeak, voicesForLang } from './speech.js';
import {
  addBook,
  getBook,
  getBookContent,
  findBookByTitle,
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
  getKbUrl,
  setKbUrl,
  getProfile,
  setProfile,
  getAiModel,
  setAiModel,
  getTtsRate,
  setTtsRate,
  getTtsVoice,
  setTtsVoice,
  SORT_OPTIONS,
  getSortBy,
  setSortBy,
  getReadingMode,
  setReadingMode,
  FONT_OPTIONS,
  getReadingFont,
  setReadingFont,
  getReadingFontOption,
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
const readingFontSelect = document.getElementById('reading-font-select');
const fileInput = document.getElementById('file-input');
const sampleButton = document.getElementById('sample-button');
const prevButton = document.getElementById('prev-page');
const nextButton = document.getElementById('next-page');
const pageIndicator = document.getElementById('page-indicator');
const menuToggle = document.getElementById('menu-toggle');
const menu = document.getElementById('menu');
const langSelect = document.getElementById('lang-select');
const readingLangSelect = document.getElementById('reading-lang-select');
const kbUrlInput = document.getElementById('kb-url');
const profileInput = document.getElementById('profile-name');
const aiModelSelect = document.getElementById('ai-model-select');
const exportButton = document.getElementById('export-words');
const importInput = document.getElementById('import-words');
const resetButton = document.getElementById('reset-data');
const themeSwatches = document.getElementById('theme-swatches');

let paginator = null;
let pageTurn = null; // live drag page-turn controller (paged mode only)
let currentBookId = null;
let currentContent = null; // {text, images} of the open book (to re-render on mode change)
let currentView = 'grid';

initTheme();
applyReadingFont();
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
  // An uploaded cover is rendered as the book's first image (cover.js anchors it at
  // offset 0), so the book opens with it exactly as it looks on the shelf.
  showDocument(
    { text: content.text, images: imagesWithCover(book, content.images) },
    { restoreIndex: book?.progressWordIndex || 0 },
  );
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

  // The same file added twice is the other way a shelf ends up with two copies of
  // one book. Extraction is the expensive step and re-doing it is pure waste, so ask
  // BEFORE it: keeping the copy you have is almost always what was meant.
  const existing = await findBookByTitle(file.name.replace(/\.[^.]+$/, ''));
  if (existing) {
    const again = await confirmDialog(
      `“${existing.title}” is already in your library. Add a second copy?`,
      { confirmLabel: 'Add a copy' },
    );
    if (!again) {
      await openBook(existing.id);
      return;
    }
  }

  const lang = (await pickReadingLang('What language is this book in?', getDefaultReadingLang())) || getDefaultReadingLang();
  setActiveReadingLang(lang);
  setView('reader');
  reader.innerHTML = '<p class="reader__placeholder">Loading…</p>';
  try {
    const { text, images } = await ingest(file);
    // The document's own cover: the image it opens with, if it has one. An
    // illustration deep in the text is not a cover (see cover.js).
    const cover = documentCover(images)?.blob || null;
    const title = file.name.replace(/\.[^.]+$/, '');
    const id = await addBook({ title, text, images, cover, lang, wordData: bookWordData(text) });
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
  if (open) {
    showChrome();
    populateAiModelOptions();
    populateVoiceOptions();
  }
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

// The bars are a distraction mid-page, so they only reveal near the screen edges
// where they live: hovering (mouse) or tapping (touch) within CHROME_EDGE px of the
// top or bottom. A tap in the reading area turns the page instead (see pageTurn.js).
const CHROME_EDGE = 72;
const nearEdge = (y) => y < CHROME_EDGE || y > window.innerHeight - CHROME_EDGE;

document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && nearEdge(e.clientY)) showChrome();
});
document.addEventListener('pointerdown', (e) => {
  if (nearEdge(e.clientY)) showChrome();
});
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

// --- Home server config ---
kbUrlInput.value = getKbUrl();
kbUrlInput.addEventListener('change', () => setKbUrl(kbUrlInput.value));

profileInput.value = getProfile();
profileInput.addEventListener('change', () => {
  setProfile(profileInput.value);
  syncNow(); // adopt the new profile: push local state, pull that profile's progress
});

// --- AI model (Ollama) ---
// The saved setting is the source of truth for the selection — never the select's
// own value: the select starts with only the "Server default" option, so assigning
// a saved model name before its option exists silently falls back to "".
function setAiModelOptions(models) {
  const current = getAiModel();
  aiModelSelect.innerHTML = '<option value="">Server default</option>';
  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    aiModelSelect.appendChild(opt);
  }
  // Keep a saved model selectable even when it's not in the fresh list (server
  // unreachable, model removed) so the control never misreports the setting.
  if (current && !models.includes(current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current} (saved)`;
    aiModelSelect.appendChild(opt);
  }
  aiModelSelect.value = current;
}
setAiModelOptions([]);
aiModelSelect.addEventListener('change', () => setAiModel(aiModelSelect.value));

// Fetches the server's installed Ollama models each time the menu opens (cheap,
// and picks up models pulled since the last visit) and repopulates the <select>.
let aiModelsLoaded = false;
async function populateAiModelOptions() {
  const models = await listAiModels();
  if (!models.length && aiModelsLoaded) return; // keep what we have on a transient miss
  setAiModelOptions(models);
  aiModelsLoaded = models.length > 0;
}

// --- Read-aloud voice & speed (Web Speech) ---
// Hidden entirely when the browser has no speech synthesis. The voice list is
// rebuilt each time the menu opens: it is filtered to the CURRENT reading
// language (voices are per language), and engines load voices asynchronously.
const voiceField = document.getElementById('voice-field');
const voiceRateField = document.getElementById('voice-rate-field');
const voiceSelect = document.getElementById('voice-select');
const voiceRateSelect = document.getElementById('voice-rate-select');

if (!canSpeak()) {
  voiceField.hidden = true;
  voiceRateField.hidden = true;
}

voiceRateSelect.value = String(getTtsRate());
if (voiceRateSelect.value === '') voiceRateSelect.value = '0.9'; // saved value not an option
voiceRateSelect.addEventListener('change', () => setTtsRate(voiceRateSelect.value));

voiceSelect.addEventListener('change', () => setTtsVoice(voiceSelect.value));

function populateVoiceOptions() {
  if (!canSpeak()) return;
  const current = getTtsVoice(); // the setting is the source of truth, not the select
  voiceSelect.innerHTML = '<option value="">Auto (language default)</option>';
  for (const v of voicesForLang(getReadingLang())) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }
  voiceSelect.value = current;
  if (voiceSelect.value !== current) voiceSelect.value = ''; // saved voice not installed here
}

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

// Push the selected reader typeface into the CSS variables the reading flow reads.
function applyReadingFont() {
  const { stack, weight } = getReadingFontOption();
  const root = document.documentElement.style;
  root.setProperty('--reader-font', stack);
  root.setProperty('--reader-weight', weight);
}

function showDocument({ text, images = [] }, { restoreIndex = 0 } = {}) {
  if (pageTurn) {
    pageTurn.destroy();
    pageTurn = null;
  }
  if (paginator) paginator.destroy();
  currentContent = { text, images };
  applyRedSeaSuppression();

  const continuous = getReadingMode() === 'continuous';
  reader.classList.toggle('reader--scroll', continuous);
  pager.hidden = continuous; // no page buttons in continuous mode

  const tokens = tokenize(text);
  const Reader = continuous ? Scroller : Paginator;
  paginator = new Reader(reader, tokens, images);
  // Listen on the full-width wrap so the empty side margins turn pages too.
  if (!continuous) pageTurn = attachPageTurn(paginator, { surface: readerWrap });
  attachMarking(paginator.content, {
    getSentence: buildSentenceLookup(text, tokens),
    getParagraph: buildParagraphLookup(text, tokens),
    book: { uid: currentBookId || '' },
  });

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
  reRenderAtCurrentSpot();
});

// Reading font: populate options, then re-paginate on change (the new metrics
// shift where pages break, so a full re-render keeps the position honest).
for (const { value, label } of FONT_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  readingFontSelect.appendChild(opt);
}
readingFontSelect.value = getReadingFont();
readingFontSelect.addEventListener('change', () => {
  setReadingFont(readingFontSelect.value);
  applyReadingFont();
  reRenderAtCurrentSpot();
});

// Re-render the open book (if any) at the reader's current position.
function reRenderAtCurrentSpot() {
  if (currentContent && !readerWrap.hidden) {
    const at = paginator ? paginator.currentFirstWordIndex() : 0;
    showDocument(currentContent, { restoreIndex: at });
  }
}
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
    wordData: bookWordData(text),
    lang: 'en',
  });
  await openBook(id);
});

// --- Startup: migrate any old single document, then show the shelf ---
migrateOldDocument()
  .catch(() => {})
  .finally(showShelf);

// --- Page navigation ---
// Buttons and arrow keys route through the page-turn controller (animated slide)
// in paged mode; in continuous mode there is no controller, so they no-op / scroll.
const turnPrev = () => (pageTurn ? pageTurn.prev() : paginator?.prev());
const turnNext = () => (pageTurn ? pageTurn.next() : paginator?.next());

prevButton.addEventListener('click', turnPrev);
nextButton.addEventListener('click', turnNext);

document.addEventListener('keydown', (e) => {
  if (!paginator || readerWrap.hidden) return;
  if (e.key === 'ArrowLeft') turnPrev();
  else if (e.key === 'ArrowRight') turnNext();
});

// The live drag turn (finger follows the page) is wired per-document in
// showDocument via attachPageTurn — see src/reader/pageTurn.js.
