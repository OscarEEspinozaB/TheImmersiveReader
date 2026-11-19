// Files reaching the desktop app from outside: dropped on the window or sent by the
// system's "Open with" (src-tauri/src/files.rs). Native code decides which files were
// offered; this module shows the drag state and hands each offer to main.js, one at a
// time, so a second drop waits for the first one's dialogs. No-op outside the app.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isDesktopApp } from './desktop.js';
import { logDiagError } from './diagnostics.js';

const TEXT_FILE = /\.(md|markdown|txt|text)$/i;

/**
 * Where an offered file belongs. PDF, EPUB and .tir are always books. A text file is a
 * note, unless it was dropped on My Books.
 * @returns {'book'|'note'}
 */
export function fileDestination(name, { view, source }) {
  if (!TEXT_FILE.test(name)) return 'book';
  return source === 'drop' && view === 'shelf' ? 'book' : 'note';
}

/** @returns {Promise<File>} the contents of an offered file (each can be read once) */
export async function readOfferedFile({ id, name }) {
  const bytes = await invoke('file_read', { id });
  return new File([bytes], name);
}

let statusBar = null;

/** Show a progress line while files are added; null removes it. */
export function setFileStatus(message) {
  if (!message) {
    statusBar?.remove();
    statusBar = null;
    return;
  }
  if (!statusBar) {
    statusBar = document.createElement('div');
    statusBar.className = 'app-update';
    statusBar.setAttribute('role', 'status');
    document.body.append(statusBar);
  }
  statusBar.textContent = message;
}

function showDragState(overlay, { active, supported }) {
  overlay.hidden = !active;
  overlay.textContent = supported ? 'Drop to add' : 'Only PDF, EPUB, Markdown, text and .tir files';
}

/**
 * Start receiving files. Call once the first view is up: anything offered earlier, such
 * as the file the app was opened with, is waiting and is delivered now.
 * @param {(offer: { source: 'drop'|'open', files: {id: number, name: string}[], skipped: string[] }) => Promise<void>} onOffer
 */
export async function initDesktopFiles(onOffer) {
  if (!isDesktopApp) return;

  const overlay = document.createElement('div');
  overlay.className = 'file-drop';
  overlay.hidden = true;
  document.body.append(overlay);

  let queue = Promise.resolve();
  const collect = () => {
    queue = queue
      .then(() => invoke('files_take'))
      .then(async (offers) => {
        for (const offer of offers) await onOffer(offer);
      })
      .catch((err) => logDiagError('desktop-files', err));
  };

  try {
    await listen('files-drag', (e) => showDragState(overlay, e.payload));
    await listen('files-offered', collect);
  } catch (err) {
    logDiagError('desktop-files', err);
  }
  collect();
}
