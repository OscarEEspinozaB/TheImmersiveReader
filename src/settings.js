// User settings: small, persisted configuration. For now just the native
// language used for the on-demand "explain in my language" rescue via Ollama.

// Build-time defaults live in one place — ../app.config.json — so shipping a
// different home-server IP or default language never means touching code. These
// are DEFAULTS ONLY: every value below can be overridden at runtime in Settings,
// and the user's choice (persisted in localStorage) always wins over the config.
import appConfig from '../app.config.json';

const STORAGE_KEY = 'immersive-reader.settings.v1';

// Native language (for the "explain in my language" rescue). Names are used
// verbatim in the prompt, so keep them in English.
export const LANGUAGES = ['Spanish', 'English', 'French', 'Portuguese', 'German', 'Italian'];

// Reading language = the language of the book. `code` drives Intl.Segmenter and the
// dictionary providers (KB + freedictionaryapi.com); `name` is used in prompts.
// The public dictionary maps pt-BR → pt internally (see definitions/freeDict.js).
export const READING_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt-BR', name: 'Portuguese' },
  { code: 'ko', name: 'Korean' },
];

export const SORT_OPTIONS = [
  { value: 'lastRead', label: 'Last read' },
  { value: 'title', label: 'Title' },
  { value: 'added', label: 'Date added' },
];

// Reader typeface options. `stack` is applied to the reading flow via the
// --reader-font CSS variable; `weight` via --reader-weight (Literata is a variable
// font, so a lighter 380 reads comfortably for long sessions; the static system
// fonts round it to their nearest available weight). Literata is bundled and
// self-hosted (see the @fontsource import in main.js), so it works offline.
// Reader font-size steps, as a percentage of the base reading size. Applied via
// the --reader-font-size CSS variable (a unitless multiplier). Replaces the
// browser zoom the web reader relied on — the WebView APK has no such control.
export const FONT_SIZE_OPTIONS = [
  { value: 85, label: 'Small' },
  { value: 100, label: 'Normal' },
  { value: 115, label: 'Large' },
  { value: 130, label: 'Larger' },
  { value: 150, label: 'Huge' },
];

export const FONT_OPTIONS = [
  { value: 'literata', label: 'Literata (recommended)', stack: "'Literata Variable', Georgia, serif", weight: '380' },
  { value: 'georgia', label: 'Georgia', stack: "Georgia, 'Iowan Old Style', 'Times New Roman', serif", weight: '400' },
  { value: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif", weight: '400' },
  { value: 'arial', label: 'Arial', stack: "Arial, Helvetica, sans-serif", weight: '400' },
  { value: 'verdana', label: 'Verdana', stack: "Verdana, Geneva, sans-serif", weight: '400' },
  { value: 'mono', label: 'Monospace', stack: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace", weight: '400' },
];

// Line spacing, applied via the --reader-line-height CSS variable to both the reader
// flow and the note editor (they share the reading typography).
export const LINE_SPACING_OPTIONS = [
  { value: 1.4, label: 'Tight' },
  { value: 1.65, label: 'Normal' },
  { value: 1.9, label: 'Relaxed' },
  { value: 2.2, label: 'Loose' },
];
const settings = {
  language: appConfig.defaults.nativeLanguage,
  defaultReadingLang: appConfig.defaults.readingLanguage, // default for NEW books; each book stores its own lang
  // Local dictionary KB service on the LAN. Defaults to the home machine (from
  // app.config.json) so the offline dictionary works out of the box with no
  // configuration. On the phone this default must be the server's LAN IP.
  kbUrl: appConfig.server.defaultUrl,
  // Where the ANDROID app pulls its web updates from (OTA — src/appUpdate.js).
  // Meaningless on the web, which is always served the current build by whoever
  // hosts it. Empty = use kbUrl: the bundle is normally published to the same home
  // server, and this exists so the two can be split without touching code.
  updateUrl: appConfig.server.updateUrl,
  // Lightweight profile name for per-user vocabulary sync (empty = sync off, the
  // vocabulary stays device-local). No password — trusted home LAN.
  profile: '',
  sortBy: appConfig.defaults.sortBy,
  notesSortBy: appConfig.defaults.sortBy, // the Notes shelf's own order (same options)
  readingMode: appConfig.defaults.readingMode, // 'paged' | 'continuous'
  readingFont: appConfig.defaults.readingFont, // reader typeface (see FONT_OPTIONS)
  readingFontSize: appConfig.defaults.readingFontSize, // % of base size (see FONT_SIZE_OPTIONS)
  readingLineHeight: 1.65, // line spacing multiplier (see LINE_SPACING_OPTIONS)
  // Ollama model for AI explanations (server/generate/explain.js). '' = the
  // server's own default (KB_EXPLAIN_MODEL), no override sent.
  aiModel: appConfig.defaults.aiModel,
  // Read-aloud (Web Speech): utterance rate and preferred voice ('' = auto —
  // the first installed voice matching the reading language, else the engine default).
  ttsRate: appConfig.defaults.ttsRate,
  ttsVoice: '', // a SpeechSynthesisVoice.voiceURI
};

// The language currently in effect = the open book's language. NOT persisted:
// it is set per book on open (see main.js). The tokenizer, sentence splitter and
// definition layer read it through getReadingLang()/getReadingLangName(), so they
// always reflect the book being read. Falls back to the default when no book is open.
let activeReadingLang = settings.defaultReadingLang;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (LANGUAGES.includes(obj.language)) settings.language = obj.language;
    // `readingLang` is the legacy (pre per-book) key; fall back to it on upgrade.
    const legacyLang = obj.defaultReadingLang ?? obj.readingLang;
    if (READING_LANGUAGES.some((l) => l.code === legacyLang)) settings.defaultReadingLang = legacyLang;
    activeReadingLang = settings.defaultReadingLang;
    // Only a non-empty saved value overrides the default — a blank/absent one
    // keeps the built-in home IP, so the local dictionary stays on by default.
    if (typeof obj.kbUrl === 'string' && obj.kbUrl) settings.kbUrl = obj.kbUrl;
    if (typeof obj.updateUrl === 'string') settings.updateUrl = obj.updateUrl;
    if (typeof obj.profile === 'string') settings.profile = obj.profile;
    if (SORT_OPTIONS.some((o) => o.value === obj.sortBy)) settings.sortBy = obj.sortBy;
    if (SORT_OPTIONS.some((o) => o.value === obj.notesSortBy)) settings.notesSortBy = obj.notesSortBy;
    if (obj.readingMode === 'paged' || obj.readingMode === 'continuous') settings.readingMode = obj.readingMode;
    if (FONT_OPTIONS.some((o) => o.value === obj.readingFont)) settings.readingFont = obj.readingFont;
    if (FONT_SIZE_OPTIONS.some((o) => o.value === obj.readingFontSize)) settings.readingFontSize = obj.readingFontSize;
    if (LINE_SPACING_OPTIONS.some((o) => o.value === obj.readingLineHeight)) settings.readingLineHeight = obj.readingLineHeight;
    if (typeof obj.aiModel === 'string') settings.aiModel = obj.aiModel;
    if (Number.isFinite(obj.ttsRate) && obj.ttsRate >= 0.5 && obj.ttsRate <= 2) settings.ttsRate = obj.ttsRate;
    if (typeof obj.ttsVoice === 'string') settings.ttsVoice = obj.ttsVoice;
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

/** Active reading language code (the open book's language), e.g. "en". */
export function getReadingLang() {
  return activeReadingLang;
}

/** Active reading language display name, e.g. "English". */
export function getReadingLangName() {
  return READING_LANGUAGES.find((l) => l.code === activeReadingLang)?.name || 'English';
}

/** Set the language in effect (the open book's). Runtime only — not persisted. */
export function setActiveReadingLang(code) {
  if (READING_LANGUAGES.some((l) => l.code === code)) {
    activeReadingLang = code;
  }
}

/** Default reading language for NEW books (persisted), e.g. "en". */
export function getDefaultReadingLang() {
  return settings.defaultReadingLang;
}

export function setDefaultReadingLang(code) {
  if (READING_LANGUAGES.some((l) => l.code === code)) {
    settings.defaultReadingLang = code;
    save();
  }
}

/** Map a reading-language code to its display name (e.g. "es" → "Spanish"). */
export function readingLangName(code) {
  return READING_LANGUAGES.find((l) => l.code === code)?.name || code;
}

/** Local dictionary KB service URL, e.g. "http://192.168.100.6:4321" (empty = off). */
export function getKbUrl() {
  return settings.kbUrl;
}

export function setKbUrl(url) {
  settings.kbUrl = (url || '').trim().replace(/\/+$/, '');
  save();
}

/**
 * Base URL the Android app fetches web updates from (`/app/latest`,
 * `/app/bundle.zip`). Falls back to the home-server URL, which is where
 * `npm run app:publish` puts the bundle. Android-only; ignored on the web.
 */
export function getUpdateUrl() {
  return settings.updateUrl || settings.kbUrl;
}

export function setUpdateUrl(url) {
  settings.updateUrl = (url || '').trim().replace(/\/+$/, '');
  save();
}

/** Lightweight profile name for vocabulary sync (empty = sync off). */
export function getProfile() {
  return settings.profile;
}

export function setProfile(name) {
  settings.profile = (name || '').trim();
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

/** Notes shelf sort order (same options as the library): "lastRead" | "title" | "added". */
export function getNotesSortBy() {
  return settings.notesSortBy;
}

export function setNotesSortBy(value) {
  if (SORT_OPTIONS.some((o) => o.value === value)) {
    settings.notesSortBy = value;
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

/** Reader typeface id (see FONT_OPTIONS), e.g. "literata". */
export function getReadingFont() {
  return settings.readingFont;
}

export function setReadingFont(value) {
  if (FONT_OPTIONS.some((o) => o.value === value)) {
    settings.readingFont = value;
    save();
  }
}

/** The FONT_OPTIONS entry currently in effect (never null). */
export function getReadingFontOption() {
  return FONT_OPTIONS.find((o) => o.value === settings.readingFont) || FONT_OPTIONS[0];
}

/** Reader font size as a percentage of the base (e.g. 100), see FONT_SIZE_OPTIONS. */
export function getReadingFontSize() {
  return settings.readingFontSize;
}

export function setReadingFontSize(value) {
  const n = Number(value);
  if (FONT_SIZE_OPTIONS.some((o) => o.value === n)) {
    settings.readingFontSize = n;
    save();
  }
}

/** Line spacing multiplier for the reader and the note editor. */
export function getReadingLineHeight() {
  return settings.readingLineHeight;
}

export function setReadingLineHeight(value) {
  const n = Number(value);
  if (LINE_SPACING_OPTIONS.some((o) => o.value === n)) {
    settings.readingLineHeight = n;
    save();
  }
}

/** Ollama model override for AI explanations, e.g. "gemma4:e4b" ('' = server default). */
export function getAiModel() {
  return settings.aiModel;
}

export function setAiModel(name) {
  settings.aiModel = (name || '').trim();
  save();
}

/** Read-aloud speed (SpeechSynthesisUtterance.rate), e.g. 0.9. */
export function getTtsRate() {
  return settings.ttsRate;
}

export function setTtsRate(rate) {
  const r = Number(rate);
  if (Number.isFinite(r) && r >= 0.5 && r <= 2) {
    settings.ttsRate = r;
    save();
  }
}

/** Preferred read-aloud voice (voiceURI); '' = auto by reading language. */
export function getTtsVoice() {
  return settings.ttsVoice;
}

export function setTtsVoice(voiceURI) {
  settings.ttsVoice = voiceURI || '';
  save();
}

load();
