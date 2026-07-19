// App entry point: a bookshelf (library) and a reader. On load you see the shelf;
// opening a book switches to the reader. Books (text + images) live in IndexedDB.

import { ingest } from './ingest/index.js';
import { tokenize } from './tokenizer.js';
import { load as loadVocabulary, exportVocabulary, importVocabulary, resetAll } from './vocabulary.js';
import '@fontsource-variable/literata/wght.css'; // self-hosted reader font (offline)
import { Paginator } from './reader/paginator.js';
import { Scroller } from './reader/scroller.js';
import { attachPageTurn } from './reader/pageTurn.js';
import { initTheme, setTheme, getTheme, THEMES, refreshStatusBarStyle } from './reader/theme.js';
import { initStatusBar } from './statusBar.js';
import { initAppUpdate, isNativeApp, currentBundle, checkNow, rollbackToPrevious } from './appUpdate.js';
import { attachMarking, hidePopup } from './marking.js';
import { hideGloss } from './gloss.js';
import { App as CapacitorApp } from '@capacitor/app';
import {
  buildSentenceLookup,
  buildParagraphLookup,
  buildParagraphSpeechLookup,
} from './sentences.js';
import { migrateVocabularyEntries, resetLearned } from './contractions.js';
import { renderShelf } from './shelf.js';
import { renderServerShelf } from './serverShelf.js';
import { initVocabSync, syncNow } from './vocabSync.js';
import { pullPosition, pushPosition } from './positionSync.js';
import { buildParagraphs, wordStartsOf, wordIndexToPosition, positionToWordIndex } from './reader/position.js';
import { recolorWord } from './reader/render.js';
import { renderProgress, renderDictionary } from './dashboard.js';
import { buildDeck, bookWordData } from './deck.js';
import { importTir } from './tir.js';
import { prepareCover, documentCover, imagesWithCover } from './cover.js';
import { renderSwiper } from './swiper.js';
import { alertDialog, confirmDialog, selectDialog } from './dialog.js';
import { listAiModels } from './definitions/index.js';
import { canSpeak, voiceGroupsForLang } from './speech.js';
import { stopReading } from './readAloud.js';
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
  getUpdateUrl,
  setUpdateUrl,
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
  FONT_SIZE_OPTIONS,
  getReadingFont,
  setReadingFont,
  getReadingFontOption,
  getReadingFontSize,
  setReadingFontSize,
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
const readingSizeSelect = document.getElementById('reading-size-select');
const prevButton = document.getElementById('prev-page');
const nextButton = document.getElementById('next-page');
const pageIndicator = document.getElementById('page-indicator');
const pageBook = document.getElementById('page-book');
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
const appUpdateSection = document.getElementById('app-update-section');
const updateUrlInput = document.getElementById('update-url');
const appVersionLabel = document.getElementById('app-version');
const checkUpdateButton = document.getElementById('check-update');
const resetAppButton = document.getElementById('reset-app');

let paginator = null;
let pageTurn = null; // live drag page-turn controller (paged mode only)
let currentBookId = null;
let currentBookTitle = ''; // cross-device reading-position key (see positionSync.js)
let currentContent = null; // {text, images} of the open book (to re-render on mode change)
// Paragraph spans + word offsets of the open book, to translate the reader's word
// index to/from the stored paragraph-anchored position (src/reader/position.js).
let currentParagraphs = [];
let currentWordStarts = [];
let lastSavedPosKey = ''; // "paragraph:word" last persisted, to skip redundant saves
let currentView = 'grid';

initTheme();
// Enable edge-to-edge (WebView under the status bar) on native, then push the
// current theme's icon color once the plugin has loaded. No-op on the web.
initStatusBar().then(refreshStatusBarStyle);
// Confirm this web bundle boots, then pull a newer one from the home server if
// there is one (OTA — no APK reinstall). No-op on the web / offline.
initAppUpdate({ onStaged: (version) => showAppVersion(version) });
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
// The nav view currently on screen ('shelf' | 'server' | 'dictionary' |
// 'progress' | 'reader' | 'swiper'). Distinct from `currentView`, which is the
// shelf's grid/list layout. Drives the hardware back button (see below).
let activeView = 'shelf';

function setView(view) {
  activeView = view;
  const reading = view === 'reader';
  // Leaving the reader ends a continuous read-aloud: the voice must never keep
  // going (and turning pages underneath) over the library or a hub view.
  if (!reading) stopReading();
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

  // The status bar names the open book, next to the % readout. The top bar keeps
  // the app's own name always — that is the brand, not a document title.
  pageBook.textContent = reading ? currentBookTitle : '';

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
    onSample: loadSample,
  });
}

async function showShelf() {
  setMenuOpen(false);
  currentBookId = null;
  currentBookTitle = '';
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
  currentBookTitle = book?.title || '';
  setView('reader');
  // Where this device last left off: the paragraph-anchored position, or (for books
  // saved before it existed) the legacy word index — passed through as a plain number.
  const localAt = book?.progressUpdatedAt || 0;
  const restore =
    book?.progressParagraph != null
      ? { paragraph: book.progressParagraph | 0, word: book.progressWord | 0 }
      : book?.progressWordIndex || 0;
  // An uploaded cover is rendered as the book's first image (cover.js anchors it at
  // offset 0), so the book opens with it exactly as it looks on the shelf.
  showDocument(
    { text: content.text, images: imagesWithCover(book, content.images), blocks: content.blocks },
    { restore },
  );
  touchOpened(id);
  // If another device left a NEWER spot for this title, jump there once it arrives.
  resumeFromServer(id, currentBookTitle, localAt);
}

// Best-effort cross-device resume: pull the server's position for this book's title
// and, if it is newer than what this device had, jump the open reader to it.
async function resumeFromServer(id, title, localAt) {
  const remote = await pullPosition(title);
  if (!remote) {
    console.log(`[position] resume title="${title}": no server position → staying at local spot`);
    return;
  }
  if (remote.updatedAt <= localAt) {
    console.log(
      `[position] resume title="${title}": local is newer or equal ` +
        `(local updatedAt=${localAt} ≥ server=${remote.updatedAt}) → not jumping`,
    );
    return;
  }
  // Still the same book open? (the pull is async; the user may have moved on.)
  if (currentBookId !== id || readerWrap.hidden || !paginator) return;
  const targetWordIndex = positionToWordIndex(currentWordStarts, currentParagraphs, remote);
  console.log(
    `[position] resume title="${title}": jumping to server spot`,
    remote,
    `→ wordIndex ${targetWordIndex}`,
  );
  paginator.goToWordIndex(targetWordIndex);
  setProgress(id, { paragraph: remote.paragraph, word: remote.word }, remote.updatedAt);
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
    const { text, images, blocks } = await ingest(file);
    // The document's own cover: the image it opens with, if it has one. An
    // illustration deep in the text is not a cover (see cover.js).
    const cover = documentCover(images)?.blob || null;
    const title = file.name.replace(/\.[^.]+$/, '');
    const id = await addBook({ title, text, images, blocks, cover, lang, wordData: bookWordData(text) });
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
      showDocument(currentContent, { restore: at });
    }
  } else {
    setDefaultReadingLang(code);
  }
});

// --- Home server config ---
kbUrlInput.value = getKbUrl();
kbUrlInput.addEventListener('change', () => setKbUrl(kbUrlInput.value));

// --- App updates (Android only) ---
/**
 * The menu's footer line: which web bundle is running and where updates come from.
 * Updating is automatic (checked at every start), but "it updated" is invisible
 * without this — and a staged update needs to say that it wants a restart.
 * @param {string} [pendingVersion] a downloaded update waiting for the next start
 */
async function showAppVersion(pendingVersion) {
  if (!isNativeApp) return;
  appVersionLabel.hidden = false;
  appVersionLabel.classList.toggle('is-pending', !!pendingVersion);
  try {
    const b = await currentBundle();
    const running = b ? `Version ${b.version}${b.builtin ? ' (installed with the app)' : ''}` : 'Version unknown';
    appVersionLabel.textContent = pendingVersion
      ? `${running}\nUpdate ${pendingVersion} downloaded — restart to apply`
      : `${running}\nUpdates from ${getUpdateUrl() || 'not set'}`;
  } catch (err) {
    appVersionLabel.textContent = `Updater error: ${err.message}`;
  }
}


// The web is always served the build its host has, and a browser has an address bar
// to recover with; neither is true inside the APK, so this whole section exists only
// there (see src/appUpdate.js).
if (isNativeApp) {
  appUpdateSection.hidden = false;
  updateUrlInput.value = getUpdateUrl();
  updateUrlInput.addEventListener('change', () => {
    setUpdateUrl(updateUrlInput.value);
    updateUrlInput.value = getUpdateUrl(); // show the home-server fallback when cleared
  });

  showAppVersion();

  checkUpdateButton.addEventListener('click', async () => {
    const label = checkUpdateButton.querySelector('span');
    label.textContent = 'Checking…';
    // Whatever happens, the label must stop saying "Checking…" — a stuck label is
    // indistinguishable from a broken app.
    let text;
    try {
      const { status, detail } = await checkNow();
      text = {
        updated: 'Downloaded — restart to apply',
        current: 'Already up to date',
        failed: `Failed: ${detail}`,
        unsupported: 'Updates unavailable',
      }[status];
    } catch (err) {
      text = `Failed: ${err.message}`;
    }
    label.textContent = text;
    setTimeout(() => (label.textContent = 'Check for updates'), 8000);
  });

  // The way back from a bad update, with no address bar to type one. One step
  // back, to the last version that worked — good updates in between are kept.
  resetAppButton.addEventListener('click', async () => {
    if (!(await confirmDialog('Go back to the previous version of the app?'))) return;
    await rollbackToPrevious();
  });
}

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
  // Grouped by locale with distinct per-voice labels (see voiceGroupsForLang —
  // Android names every voice of a locale identically, so raw names collide).
  for (const group of voiceGroupsForLang(getReadingLang())) {
    const og = document.createElement('optgroup');
    og.label = group.label;
    for (const v of group.voices) {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.label;
      og.appendChild(opt);
    }
    voiceSelect.appendChild(og);
  }
  voiceSelect.value = current;
  if (voiceSelect.value !== current) {
    // The saved voice may be the collapsed local/network twin of a listed one
    // (see voiceGroupsForLang) — show that twin as selected rather than
    // pretending the choice fell back to Auto. Otherwise: not installed here.
    const canon = (u) => u.toLowerCase().replace(/-(local|network)$/, '');
    const twin = current
      ? [...voiceSelect.options].find((o) => o.value && canon(o.value) === canon(current))
      : null;
    voiceSelect.value = twin ? twin.value : '';
  }
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
 * @param {{ restore?: number | { paragraph: number, word: number } }} [opts]
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
  root.setProperty('--reader-font-size', String(getReadingFontSize() / 100)); // unitless multiplier
}

// Follow the voice during a continuous read-aloud (`paginator` is the
// module-level current reader, so this stays valid for the open book). Paged
// mode: the page only turns when the spoken word is not on the current one.
// Scroll mode — for following the book hands-free (cooking) — every NEW
// paragraph aligns to the top band of the view, and inside a long paragraph
// the view rolls forward whenever the voice nears the bottom edge, so the
// spoken word never slips out of sight.
function followSpokenWord(wordIndex, { paragraphStart = false } = {}) {
  if (!paginator) return;
  const span = paginator.content.querySelector(`.word[data-i="${wordIndex}"]`);
  if (!span) {
    paginator.goToWordIndex(wordIndex); // off-page / outside the window: jump
    return;
  }
  if (getReadingMode() !== 'continuous') return; // paged: on-page by construction
  const vr = reader.getBoundingClientRect();
  const sr = span.getBoundingClientRect();
  const topBand = vr.top + vr.height * 0.1; // where followed text settles
  const nearBottom = sr.bottom > vr.bottom - vr.height * 0.18;
  if (paragraphStart || nearBottom || sr.top < vr.top) {
    reader.scrollTo({
      top: reader.scrollTop + (sr.top - topBand),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
}

// `restore` is either an exact word index (a number — used when re-rendering the SAME
// content on this device, e.g. a font/mode change) or a { paragraph, word } position
// (used when opening a book, possibly from another device). Paragraph-anchored so it
// lands the right paragraph even if the word segmenter disagrees across engines.
function showDocument({ text, images = [], blocks = [] }, { restore = 0 } = {}) {
  stopReading(); // a re-render/new book orphans the session's word indexes
  if (pageTurn) {
    pageTurn.destroy();
    pageTurn = null;
  }
  if (paginator) paginator.destroy();
  currentContent = { text, images, blocks };
  applyRedSeaSuppression();

  const continuous = getReadingMode() === 'continuous';
  reader.classList.toggle('reader--scroll', continuous);
  // Continuous mode reclaims the space of the HIDDEN chrome (see .reader-wrap--scroll).
  readerWrap.classList.toggle('reader-wrap--scroll', continuous);
  // The status bar stays in both modes (book + %); continuous just drops the arrows.
  pager.classList.toggle('pager--scroll', continuous);

  const tokens = tokenize(text);
  currentParagraphs = buildParagraphs(text);
  currentWordStarts = wordStartsOf(tokens);
  lastSavedPosKey = '';
  const Reader = continuous ? Scroller : Paginator;
  paginator = new Reader(reader, tokens, images, blocks);
  // Listen on the full-width wrap so the empty side margins turn pages too.
  if (!continuous) pageTurn = attachPageTurn(paginator, { surface: readerWrap });
  attachMarking(paginator.content, {
    getSentence: buildSentenceLookup(text, tokens),
    getParagraph: buildParagraphLookup(text, tokens),
    getParagraphSpeech: buildParagraphSpeechLookup(text, tokens),
    followWord: followSpokenWord,
    book: { uid: currentBookId || '' },
  });

  // Restore the saved position BEFORE wiring progress-saving, so the first event
  // reports the restored spot (not the top, which would overwrite it).
  const targetWordIndex =
    typeof restore === 'number'
      ? restore
      : positionToWordIndex(currentWordStarts, currentParagraphs, restore);
  if (targetWordIndex > 0) paginator.goToWordIndex(targetWordIndex);

  paginator.onChange(({ pct, atStart, atEnd }) => {
    pageIndicator.textContent = `${pct}%`;
    prevButton.disabled = atStart;
    nextButton.disabled = atEnd;
    saveCurrentPosition();
  });
  showChrome();
}

// Persist (and sync) where the reader is now, as a paragraph-anchored position.
// Skips the write when the paragraph:word hasn't moved (small scrolls inside a word).
function saveCurrentPosition() {
  if (!currentBookId || !paginator) return;
  const pos = wordIndexToPosition(currentWordStarts, currentParagraphs, paginator.currentFirstWordIndex());
  const key = `${pos.paragraph}:${pos.word}`;
  if (key === lastSavedPosKey) return;
  lastSavedPosKey = key;
  const now = Date.now();
  setProgress(currentBookId, pos, now);
  pushPosition(currentBookTitle, pos, now); // to the home server, keyed by title
}

// Hardware back button (Android). Capacitor's default is to exit the app; instead
// we walk back through the UI the way a user expects: dismiss any open transient
// UI first, then step out of the reader / a hub to the library, and only leave the
// app from the library itself. No-op on the web (the event never fires there).
function handleBackButton() {
  if (!menu.hidden) {
    setMenuOpen(false);
    return;
  }
  // An open bubble or popup swallows back before any navigation happens.
  if (document.querySelector('.popup:not([hidden]), .gloss:not([hidden])')) {
    hidePopup();
    hideGloss();
    return;
  }
  if (activeView === 'reader') {
    showShelf(); // saves the reading position, same as the "library" button
    return;
  }
  if (activeView !== 'shelf') {
    showShelf();
    return;
  }
  CapacitorApp.exitApp(); // already at the library root → leave the app
}
if (globalThis.Capacitor?.isNativePlatform?.()) {
  // Guard: a plugin hiccup here must never abort app startup (the shelf render
  // runs later in this module). Degrade to no back-button handling instead.
  try {
    CapacitorApp.addListener('backButton', handleBackButton);
  } catch (err) {
    console.error('backButton listener failed:', err);
  }
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

// Reading size: same story as the font — a bigger size re-flows the pages, so
// re-render at the current spot after applying the new multiplier.
for (const { value, label } of FONT_SIZE_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = String(value);
  opt.textContent = label;
  readingSizeSelect.appendChild(opt);
}
readingSizeSelect.value = String(getReadingFontSize());
readingSizeSelect.addEventListener('change', () => {
  setReadingFontSize(readingSizeSelect.value);
  applyReadingFont();
  reRenderAtCurrentSpot();
});

// Re-render the open book (if any) at the reader's current position.
function reRenderAtCurrentSpot() {
  if (currentContent && !readerWrap.hidden) {
    const at = paginator ? paginator.currentFirstWordIndex() : 0;
    showDocument(currentContent, { restore: at });
  }
}
addBookInput.addEventListener('change', (e) => addBookFromFile(e.target.files[0]));

// Offered from the empty library (see renderShelf), the one place it is useful.
async function loadSample() {
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
}

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
