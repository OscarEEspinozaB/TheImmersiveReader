// Theme palettes: selectable color schemes (dark + light). Each palette is
// defined by CSS variables under [data-theme='<id>'] in main.css; the preview
// colors here mirror those so the menu can render swatches.

import { syncStatusBarStyle } from '../statusBar.js';

const STORAGE_KEY = 'immersive-reader.theme.v1';
const DEFAULT_THEME = 'midnight';

/** @typedef {{ id: string, label: string, mode: 'dark'|'light', bg: string, known: string, learning: string, unknown: string }} Theme */

/** @type {Theme[]} */
export const THEMES = [
  { id: 'midnight', label: 'Midnight', mode: 'dark', bg: '#050505', known: '#cfcfcf', learning: '#e8a33d', unknown: '#e23b3b' },
  { id: 'slate', label: 'Slate', mode: 'dark', bg: '#0f141a', known: '#aab4bf', learning: '#e3b341', unknown: '#f76d6d' },
  { id: 'ocean', label: 'Ocean', mode: 'dark', bg: '#07171c', known: '#a6c0c3', learning: '#ffd166', unknown: '#ff6b6b' },
  { id: 'paper', label: 'Paper', mode: 'light', bg: '#fbfbf8', known: '#353535', learning: '#b9740b', unknown: '#c62828' },
  { id: 'sepia', label: 'Sepia', mode: 'light', bg: '#f7efdd', known: '#4a3f30', learning: '#a96a08', unknown: '#b3271e' },
  { id: 'mint', label: 'Mint', mode: 'light', bg: '#eef4ef', known: '#2f3a33', learning: '#936700', unknown: '#bf3326' },
];

let current = DEFAULT_THEME;

function isValid(id) {
  return THEMES.some((t) => t.id === id);
}

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  apply(isValid(saved) ? saved : DEFAULT_THEME);
}

export function getTheme() {
  return current;
}

/** Re-push the current theme's icon style (call once the native plugin loads). */
export function refreshStatusBarStyle() {
  const theme = THEMES.find((t) => t.id === current);
  if (theme) syncStatusBarStyle(theme.mode);
}

export function setTheme(id) {
  if (!isValid(id)) return;
  apply(id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore persistence failures */
  }
}

function apply(id) {
  current = id;
  document.documentElement.dataset.theme = id;
  const theme = THEMES.find((t) => t.id === id);
  if (theme) syncStatusBarStyle(theme.mode); // match status-bar icons on native
}
