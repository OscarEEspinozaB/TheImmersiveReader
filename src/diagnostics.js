// In-app log capture.
//
// A WebView has no address bar and no devtools: when something fails on the phone
// the error is written to a console nobody can open, and the only report that
// reaches the desk is "it didn't work". This keeps a bounded ring of what the app
// said about itself, and can dump it into a **note** — Notes are already editable
// text documents that can be read, copied and sent, so the log becomes something the
// user can hand over verbatim instead of describing from memory.
//
// Rules that keep it from becoming a liability:
//   - It captures errors and warnings ALWAYS. A capture toggle that is off when the
//     bug happens is worth nothing, and the volume of console.error/warn is tiny.
//     The toggle only adds the chatty levels (log/info/debug traces).
//   - It is bounded (a ring of MAX entries, each truncated) and persisted through a
//     throttled write, so a crash or an OTA restart does not lose the evidence.
//   - It never throws. A logger that breaks the app it is meant to diagnose is worse
//     than no logger, so every path here is wrapped.

import { getVerboseLog } from './settings.js';

/** Entries kept. ~400 lines is a long session's worth of warnings, still small. */
const MAX = 400;
/** Per-entry cap: a stack trace or a dumped object should not eat the whole ring. */
const MAX_LEN = 2000;
const STORE_KEY = 'immersive-reader:log';
/** Coalesce writes: a burst of errors should cost one localStorage write, not fifty. */
const FLUSH_MS = 2000;

/** @type {{ t: number, level: string, text: string }[]} */
let entries = [];
let flushTimer = null;
let started = false;

/** The real console methods, kept before we wrap them (so logging can't recurse). */
const original = {};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) entries = parsed.slice(-MAX);
  } catch {
    entries = []; // a corrupt log is not worth a failed boot
  }
}

function flush() {
  flushTimer = null;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded (the log is the least valuable thing in storage): halve it and
    // give up quietly if even that fails.
    entries = entries.slice(-Math.floor(MAX / 2));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(entries));
    } catch {
      /* ignore */
    }
  }
}

function scheduleFlush() {
  if (flushTimer == null) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Render one console argument as text — objects/Errors included, without throwing. */
function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value); // circular / exotic — the type name still says something
  }
}

/**
 * Append one entry. The only way anything enters the ring.
 * @param {string} level 'error' | 'warn' | 'info' | 'log'
 * @param {unknown[]} args
 */
function push(level, args) {
  try {
    let text = args.map(stringify).join(' ');
    if (text.length > MAX_LEN) text = `${text.slice(0, MAX_LEN)}… [truncated]`;
    entries.push({ t: Date.now(), level, text });
    if (entries.length > MAX) entries = entries.slice(-MAX);
    scheduleFlush();
  } catch {
    /* never let logging break the caller */
  }
}

/**
 * Record something explicitly, from our own code, regardless of the console.
 * Use it where a `catch` would otherwise swallow the reason a feature gave up.
 * @param {string} tag short area name, e.g. 'mlkit'
 * @param {...unknown} args
 */
export function logDiag(tag, ...args) {
  push('info', [`[${tag}]`, ...args]);
}

/** Same, for a failure: always kept, even with the verbose toggle off. */
export function logDiagError(tag, ...args) {
  push('error', [`[${tag}]`, ...args]);
}

/**
 * Start capturing. Runs in this module's own body (see the bottom of the file), not
 * from a call in main.js: an `initDiagnostics()` written between the imports would be
 * hoisted BELOW every module's evaluation, which is exactly where boot failures live.
 */
function start() {
  if (started) return;
  started = true;
  load();

  for (const level of ['error', 'warn', 'info', 'log']) {
    original[level] = console[level]?.bind(console) || (() => {});
    console[level] = (...args) => {
      // error/warn are always kept; the chatty levels only when asked for, so normal
      // use does not push the interesting lines out of a bounded ring.
      if (level === 'error' || level === 'warn' || getVerboseLog()) push(level, args);
      original[level](...args);
    };
  }

  // Uncaught failures never reach console.error in every engine — capture both the
  // classic error event and the promise rejections that async code produces.
  globalThis.addEventListener?.('error', (e) => {
    push('error', [`Uncaught: ${e.message}`, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '']);
  });
  globalThis.addEventListener?.('unhandledrejection', (e) => {
    push('error', ['Unhandled rejection:', e.reason]);
  });

  // Writes are throttled, so the last seconds before the app goes away are exactly
  // the ones a crash report needs and the ones the timer would lose. Android kills a
  // backgrounded WebView without warning: `pagehide` and the hidden transition are
  // the last points guaranteed to run.
  globalThis.addEventListener?.('pagehide', flush);
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // The log is only useful next to what produced it, and "which build is this?" is
  // the first question every phone report raises.
  logDiag('session', navigator.userAgent);
}

/** Wall-clock time, local, to the second — the phone's own clock the user sees. */
function stamp(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** How many entries are held right now (for the Settings label). */
export function logSize() {
  return entries.length;
}

/**
 * The log as plain text, newest last — the form that goes into a note or the
 * clipboard. A header carries the context a bare log lacks.
 * @param {Record<string, string>} [context] extra `key: value` header lines
 */
export function logText(context = {}) {
  const header = [
    `The Immersive Reader — log`,
    `Exported: ${new Date().toISOString()}`,
    ...Object.entries(context).map(([k, v]) => `${k}: ${v}`),
    `Entries: ${entries.length}`,
    '',
  ];
  const body = entries.map((e) => `${stamp(e.t)} ${e.level.toUpperCase().padEnd(5)} ${e.text}`);
  return [...header, ...body].join('\n');
}

/** Empty the ring — after exporting, or to isolate one reproduction from the rest. */
export function clearLog() {
  entries = [];
  flush();
}

// Side effect on import, deliberately: main.js imports this module first so capture
// is live before any other module's body has had a chance to throw.
start();
