// User settings: small, persisted configuration. For now just the native
// language used for the on-demand "explain in my language" rescue via Ollama.

const STORAGE_KEY = 'immersive-reader.settings.v1';

// Native language (for the "explain in my language" rescue). Names are used
// verbatim in the prompt, so keep them in English.
export const LANGUAGES = ['Spanish', 'English', 'French', 'Portuguese', 'German', 'Italian'];

// Reading language = the language of the book. `code` drives Intl.Segmenter and the
// dictionary API; `name` is used in prompts. Codes match dictionaryapi.dev.
export const READING_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt-BR', name: 'Portuguese' },
];

const DEFAULT_MODEL = 'gemma3:4b';
export const SORT_OPTIONS = [
  { value: 'lastRead', label: 'Last read' },
  { value: 'title', label: 'Title' },
  { value: 'added', label: 'Date added' },
];
const settings = {
  language: 'Spanish',
  readingLang: 'en',
  ollamaUrl: '',
  ollamaModel: DEFAULT_MODEL,
  sortBy: 'lastRead',
  readingMode: 'paged', // 'paged' | 'continuous'
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (LANGUAGES.includes(obj.language)) settings.language = obj.language;
    if (READING_LANGUAGES.some((l) => l.code === obj.readingLang)) settings.readingLang = obj.readingLang;
    if (typeof obj.ollamaUrl === 'string') settings.ollamaUrl = obj.ollamaUrl;
    if (typeof obj.ollamaModel === 'string' && obj.ollamaModel) settings.ollamaModel = obj.ollamaModel;
    if (SORT_OPTIONS.some((o) => o.value === obj.sortBy)) settings.sortBy = obj.sortBy;
    if (obj.readingMode === 'paged' || obj.readingMode === 'continuous') settings.readingMode = obj.readingMode;
  } catch {
    /* ignore */
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function getLanguage() {
  return settings.language;
}

export function setLanguage(name) {
  if (LANGUAGES.includes(name)) {
    settings.language = name;
    save();
  }
}

/** Reading language code (book language), e.g. "en". */
export function getReadingLang() {
  return settings.readingLang;
}

/** Reading language display name, e.g. "English". */
export function getReadingLangName() {
  return READING_LANGUAGES.find((l) => l.code === settings.readingLang)?.name || 'English';
}

export function setReadingLang(code) {
  if (READING_LANGUAGES.some((l) => l.code === code)) {
    settings.readingLang = code;
    save();
  }
}

/** Configured Ollama base URL, e.g. "http://192.168.1.50:11434" (empty = auto). */
export function getOllamaUrl() {
  return settings.ollamaUrl;
}

export function setOllamaUrl(url) {
  settings.ollamaUrl = (url || '').trim().replace(/\/+$/, '');
  save();
}

/** Ollama model name, e.g. "gemma3:4b" (see `ollama list`). */
export function getOllamaModel() {
  return settings.ollamaModel || DEFAULT_MODEL;
}

export function setOllamaModel(model) {
  settings.ollamaModel = (model || '').trim() || DEFAULT_MODEL;
  save();
}

/** Library sort order: "lastRead" | "title" | "added". */
export function getSortBy() {
  return settings.sortBy;
}

export function setSortBy(value) {
  if (SORT_OPTIONS.some((o) => o.value === value)) {
    settings.sortBy = value;
    save();
  }
}

/** Reading mode: "paged" (page turns) | "continuous" (scroll). */
export function getReadingMode() {
  return settings.readingMode;
}

export function setReadingMode(mode) {
  if (mode === 'paged' || mode === 'continuous') {
    settings.readingMode = mode;
    save();
  }
}

load();
