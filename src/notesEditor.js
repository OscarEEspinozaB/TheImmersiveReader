// Note editor: a plain text editor for the reader's own notes. It is deliberately
// NOT a paste box — you write here, and "Paste" is only a convenience that drops the
// clipboard in at the cursor. Saving parses the text as Markdown (so its symbols are
// never read aloud) and stores it as a note.
//
// The note's LANGUAGE is a visible chip in the toolbar, not a question at save: it
// starts on the writer's own language ("My language" — what a pasted text usually
// is) and one tap switches it. It is never auto-detected. Saving opens the note in
// the reader straight away (main.js), so writing → listening is one action.
//
// The gear opens a settings popover with the editor's font, text size and line
// spacing — the SAME settings the reader uses, so a note reads the way it was
// written.
//
// Leaving with unsaved changes asks first (Back button and Android back alike):
// a long paste must never be lost to one stray tap.

import { addNote, updateNote, getBook, getBookContent } from './library.js';
import {
  READING_LANGUAGES, nativeLangCode,
  FONT_OPTIONS, FONT_SIZE_OPTIONS, LINE_SPACING_OPTIONS,
  getReadingFont, setReadingFont, getReadingFontSize, setReadingFontSize,
  getReadingLineHeight, setReadingLineHeight,
} from './settings.js';
import { alertDialog, confirmDialog } from './dialog.js';
import { logDiagError } from './diagnostics.js';

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
// What the editor held when it opened — leaving with anything different asks first.
let saved = { title: '', text: '', lang: '' };
let callbacks = { onSaved: () => {}, onExit: () => {}, onStyleChange: () => {} };

/**
 * Wire the editor's controls once.
 * @param {{ onSaved:(id:string)=>void, onExit:()=>void, onStyleChange:()=>void }} cb
 *   `onSaved` receives the saved note's id (main.js opens it in the reader).
 *   `onStyleChange` re-applies the shared reader CSS variables after a font/size/
 *   line-spacing change (so both editor and reader update).
 */
export function initNoteEditor({ onSaved, onExit, onStyleChange }) {
  callbacks = { onSaved, onExit, onStyleChange };
  textArea.addEventListener('input', updateCount);
  pasteBtn.addEventListener('click', pasteFromClipboard);
  saveBtn.addEventListener('click', save);
  backBtn.addEventListener('click', requestExit);
  fillSelect(langSelect, READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })));
  buildSettingsMenu();
}

/**
 * Leave the editor — after confirming, when there are unsaved changes. The editor's
 * Back button and the Android back button both come through here.
 */
export async function requestExit() {
  if (isDirty()) {
    const discard = await confirmDialog(
      currentId ? 'Discard your changes to this note?' : 'Discard this note?',
      { confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true },
    );
    if (!discard) return;
  }
  callbacks.onExit();
}

function currentState() {
  return { title: titleInput.value.trim(), text: textArea.value.trim(), lang: langSelect.value };
}

function isDirty() {
  const now = currentState();
  // A new note with nothing written is not worth a question, whatever its language.
  if (!currentId && !now.title && !now.text) return false;
  return now.title !== saved.title || now.text !== saved.text || now.lang !== saved.lang;
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
    langSelect.value = book?.lang || nativeLangCode();
  } else {
    heading.textContent = 'New note';
    titleInput.value = '';
    textArea.value = '';
    // A new note starts in the writer's own language; the chip changes it.
    langSelect.value = nativeLangCode();
  }
  saved = currentState();
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
  } catch (err) {
    // Clipboard read can be blocked (permissions, insecure context — the Android
    // WebView does not grant clipboard reads). Log WHY, since on the phone it is
    // otherwise invisible; the manual paste (long-press → Paste) still works, so
    // tell the writer and put the cursor in the text, ready for it.
    logDiagError(
      'notes',
      `clipboard read failed (secure context: ${globalThis.isSecureContext}, ` +
        `readText: ${typeof navigator.clipboard?.readText})`,
      err?.name || '',
      err?.message || String(err),
    );
    await alertDialog('Could not read the clipboard here. Long-press the editor and choose Paste.');
    textArea.focus();
  }
}

async function save() {
  const text = textArea.value.trim();
  if (!text) {
    await alertDialog('Write or paste some text first.');
    return;
  }
  const title = titleInput.value.trim();
  const lang = langSelect.value;
  saveBtn.disabled = true;
  try {
    let id = currentId;
    if (id) await updateNote(id, { title: title || undefined, text, lang });
    else id = await addNote({ title: title || undefined, text, lang });
    currentId = id;
    saved = currentState(); // nothing left unsaved
    callbacks.onSaved(id);
  } catch (err) {
    console.error(err);
    await alertDialog(`Could not save this note: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
  }
}

// --- Settings popover -------------------------------------------------------------

function buildSettingsMenu() {
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

  fontSelect.addEventListener('change', () => { setReadingFont(fontSelect.value); callbacks.onStyleChange(); });
  sizeSelect.addEventListener('change', () => { setReadingFontSize(sizeSelect.value); callbacks.onStyleChange(); });
  lineSelect.addEventListener('change', () => { setReadingLineHeight(lineSelect.value); callbacks.onStyleChange(); });
}

// Reflect the shared type settings in the controls.
function syncSettingsControls() {
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
