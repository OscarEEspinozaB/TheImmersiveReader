// Note editor: a plain text editor for the reader's own notes. It is deliberately
// NOT a paste box — you write here, and "Paste" is only a convenience that drops the
// clipboard in at the cursor. Saving parses the text as Markdown (so its symbols are
// never read aloud) and stores it as a note.
//
// The gear opens a settings popover: the note's language plus the editor's font,
// text size and line spacing. Font/size/line-spacing are the SAME settings the
// reader uses (so a note reads the way it was written); language is per-note —
// chosen here (defaulting to the reading language, never auto-detected) and used at
// save time for a new note, or applied immediately when editing an existing one.

import { addNote, updateNote, getBook, getBookContent, setBookLang } from './library.js';
import {
  READING_LANGUAGES, getDefaultReadingLang,
  FONT_OPTIONS, FONT_SIZE_OPTIONS, LINE_SPACING_OPTIONS,
  getReadingFont, setReadingFont, getReadingFontSize, setReadingFontSize,
  getReadingLineHeight, setReadingLineHeight,
} from './settings.js';
import { alertDialog, selectDialog } from './dialog.js';

const heading = document.getElementById('editor-heading');
const titleInput = document.getElementById('editor-title');
const textArea = document.getElementById('editor-text');
const pasteBtn = document.getElementById('editor-paste');
const countEl = document.getElementById('editor-count');
const saveBtn = document.getElementById('editor-save');
const backBtn = document.getElementById('editor-back');
const settingsBtn = document.getElementById('editor-settings');
const settingsMenu = document.getElementById('editor-settings-menu');
const langSelect = document.getElementById('editor-lang-select');
const fontSelect = document.getElementById('editor-font-select');
const sizeSelect = document.getElementById('editor-size-select');
const lineSelect = document.getElementById('editor-linespacing-select');

let currentId = null; // the note being edited, or null for a brand-new one
let pendingLang = getDefaultReadingLang(); // a new note's chosen language, used at save
// Whether the writer picked the language explicitly (in the settings popover). When
// they haven't, saving a NEW note asks — the same way importing a book does — rather
// than silently assuming the default language.
let langChosen = false;
let callbacks = { onSaved: () => {}, onExit: () => {}, onStyleChange: () => {} };

/**
 * Wire the editor's controls once.
 * @param {{ onSaved:(id:string)=>void, onExit:()=>void, onStyleChange:()=>void }} cb
 *   `onStyleChange` re-applies the shared reader CSS variables after a font/size/
 *   line-spacing change (so both editor and reader update).
 */
export function initNoteEditor({ onSaved, onExit, onStyleChange }) {
  callbacks = { onSaved, onExit, onStyleChange };
  textArea.addEventListener('input', updateCount);
  pasteBtn.addEventListener('click', pasteFromClipboard);
  saveBtn.addEventListener('click', save);
  backBtn.addEventListener('click', () => callbacks.onExit());
  buildSettingsMenu();
}

/**
 * Populate the editor for a new note (no id) or an existing one, then focus it.
 * Call after the editor view is shown.
 * @param {string|null} [noteId]
 */
export async function openNoteEditor(noteId = null) {
  currentId = noteId;
  settingsMenu.hidden = true;
  if (noteId) {
    const [book, content] = await Promise.all([getBook(noteId), getBookContent(noteId)]);
    heading.textContent = 'Edit note';
    titleInput.value = book?.title || '';
    // Edit the raw text the writer saved, not the Markdown-stripped reading text.
    textArea.value = content?.source ?? content?.text ?? '';
    pendingLang = book?.lang || getDefaultReadingLang();
    langChosen = true; // an existing note already has its language; editing keeps it
  } else {
    heading.textContent = 'New note';
    titleInput.value = '';
    textArea.value = '';
    pendingLang = getDefaultReadingLang();
    langChosen = false; // ask on save unless the writer picks one in settings
  }
  syncSettingsControls();
  updateCount();
  // Focus the writing surface for a new note; leave an existing one un-scrolled.
  if (!noteId) textArea.focus();
}

function updateCount() {
  const words = textArea.value.trim().split(/\s+/).filter(Boolean).length;
  countEl.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const el = textArea;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    updateCount();
  } catch {
    // Clipboard read can be blocked (permissions, insecure context). The manual
    // paste (long-press → Paste) still works; tell the writer to use it.
    await alertDialog('Could not read the clipboard here. Long-press the editor and choose Paste.');
  }
}

async function save() {
  const text = textArea.value.trim();
  if (!text) {
    await alertDialog('Write or paste some text first.');
    return;
  }
  const title = titleInput.value.trim();
  saveBtn.disabled = true;
  try {
    if (currentId) {
      await updateNote(currentId, { title: title || undefined, text });
      callbacks.onSaved(currentId);
    } else {
      // Ask for the note's language — the same as importing a book — unless the
      // writer already picked one in the settings popover.
      const lang = langChosen ? pendingLang : await askNoteLanguage();
      const id = await addNote({ title: title || undefined, text, lang });
      callbacks.onSaved(id);
    }
  } catch (err) {
    console.error(err);
    await alertDialog(`Could not save this note: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
  }
}

// Ask which language the note is written in (mirrors the book-import prompt),
// defaulting to the reading language; a cancel falls back to that default.
async function askNoteLanguage() {
  const code = await selectDialog(
    'What language is this note in?',
    READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
    getDefaultReadingLang(),
  );
  return code || getDefaultReadingLang();
}

// --- Settings popover -------------------------------------------------------------

function buildSettingsMenu() {
  fillSelect(langSelect, READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })));
  fillSelect(fontSelect, FONT_OPTIONS.map((o) => ({ value: o.value, label: o.label })));
  fillSelect(sizeSelect, FONT_SIZE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })));
  fillSelect(lineSelect, LINE_SPACING_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })));

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsMenu.hidden = !settingsMenu.hidden;
  });
  // Click outside closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!settingsMenu.hidden && !settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
      settingsMenu.hidden = true;
    }
  });

  langSelect.addEventListener('change', async () => {
    pendingLang = langSelect.value;
    langChosen = true; // an explicit pick — saving no longer needs to ask
    // For an existing note, apply the language change immediately.
    if (currentId) await setBookLang(currentId, pendingLang);
  });
  fontSelect.addEventListener('change', () => { setReadingFont(fontSelect.value); callbacks.onStyleChange(); });
  sizeSelect.addEventListener('change', () => { setReadingFontSize(sizeSelect.value); callbacks.onStyleChange(); });
  lineSelect.addEventListener('change', () => { setReadingLineHeight(lineSelect.value); callbacks.onStyleChange(); });
}

// Reflect the current per-note language and the shared type settings in the controls.
function syncSettingsControls() {
  langSelect.value = pendingLang;
  fontSelect.value = getReadingFont();
  sizeSelect.value = String(getReadingFontSize());
  lineSelect.value = String(getReadingLineHeight());
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}
