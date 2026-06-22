// User settings: small, persisted configuration. For now just the native
// language used for the on-demand "explain in my language" rescue via Ollama.

const STORAGE_KEY = 'immersive-reader.settings.v1';

// Language names are used verbatim in the Ollama prompt, so keep them in English.
export const LANGUAGES = ['Spanish', 'English', 'French', 'Portuguese', 'German', 'Italian'];

const settings = { language: 'Spanish' };

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (LANGUAGES.includes(obj.language)) settings.language = obj.language;
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

load();
