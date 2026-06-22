// App entry point: wire ingest -> tokenize -> paginated render -> marking.

import { ingest } from './ingest/index.js';
import { tokenize } from './tokenizer.js';
import { load as loadVocabulary } from './vocabulary.js';
import { Paginator } from './reader/paginator.js';
import { initTheme, setTheme, getTheme, THEMES } from './reader/theme.js';
import { attachMarking } from './marking.js';
import { buildSentenceLookup } from './sentences.js';
import { saveDocument, loadDocument, saveProgress, loadProgress } from './session.js';
import { LANGUAGES, getLanguage, setLanguage } from './settings.js';

const reader = document.getElementById('reader');
const fileInput = document.getElementById('file-input');
const sampleButton = document.getElementById('sample-button');
const prevButton = document.getElementById('prev-page');
const nextButton = document.getElementById('next-page');
const pageIndicator = document.getElementById('page-indicator');
const menuToggle = document.getElementById('menu-toggle');
const menu = document.getElementById('menu');
const langSelect = document.getElementById('lang-select');
const themeSwatches = document.getElementById('theme-swatches');

let paginator = null;

initTheme();
loadVocabulary();

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

// --- Auto-hiding chrome (top bar + pager) ---
// Bars hide while reading and reappear on activity: a tap (mobile) or mouse
// movement (desktop). They never hide before a document is loaded or while the
// menu is open.
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

// --- Language selector ---
for (const name of LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  langSelect.appendChild(opt);
}
langSelect.value = getLanguage();
langSelect.addEventListener('change', () => setLanguage(langSelect.value));

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
 * Render a document (text + optional images) as a paginated, markable reader.
 * @param {{ text: string, images?: any[] }} doc
 * @param {{ persistDoc?: boolean, restoreIndex?: number, title?: string }} [opts]
 */
function showDocument({ text, images = [] }, { persistDoc = false, restoreIndex = 0, title = '' } = {}) {
  if (paginator) paginator.destroy();

  const tokens = tokenize(text);
  paginator = new Paginator(reader, tokens, images);
  attachMarking(paginator.content, { getSentence: buildSentenceLookup(text, tokens) });

  paginator.onChange(({ pct, atStart, atEnd }) => {
    pageIndicator.textContent = `${pct}%`;
    prevButton.disabled = atStart;
    nextButton.disabled = atEnd;
    saveProgress(paginator.currentFirstWordIndex());
  });

  if (persistDoc) {
    saveDocument(title, text, images);
    saveProgress(0);
  }
  if (restoreIndex > 0) paginator.goToWordIndex(restoreIndex);

  // A document is loaded: start the auto-hide cycle for the chrome.
  hasDocument = true;
  showChrome();
}

async function loadFile(file) {
  if (!file) return;
  reader.innerHTML = '<p class="reader__placeholder">Loading…</p>';
  try {
    const doc = await ingest(file);
    showDocument(doc, { persistDoc: true, title: file.name });
  } catch (err) {
    console.error(err);
    reader.innerHTML = `<p class="reader__placeholder">Could not read this file: ${err.message}</p>`;
  }
}

fileInput.addEventListener('change', (e) => {
  setMenuOpen(false);
  loadFile(e.target.files[0]);
});

sampleButton.addEventListener('click', async () => {
  setMenuOpen(false);
  const res = await fetch(`${import.meta.env.BASE_URL}sample/sample.txt`);
  showDocument({ text: await res.text(), images: [] }, { persistDoc: true, title: 'Sample' });
});

// Restore the last opened document and reading position on startup.
loadDocument().then((savedDoc) => {
  if (savedDoc?.text) {
    showDocument(savedDoc, { restoreIndex: loadProgress(), title: savedDoc.title });
  }
});

prevButton.addEventListener('click', () => paginator?.prev());
nextButton.addEventListener('click', () => paginator?.next());

document.addEventListener('keydown', (e) => {
  if (!paginator) return;
  // Ignore arrow keys while focused inside the popup or a word (handled there).
  if (e.key === 'ArrowLeft') paginator.prev();
  else if (e.key === 'ArrowRight') paginator.next();
});

// Touch swipe: horizontal drag turns the page (left = next, right = prev).
const SWIPE_THRESHOLD = 50; // px
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
    // Only act on a mostly-horizontal swipe past the threshold.
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) paginator.next();
      else paginator.prev();
    }
  },
  { passive: true },
);
