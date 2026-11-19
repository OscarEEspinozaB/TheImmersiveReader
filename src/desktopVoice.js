// Read-aloud in the Linux desktop app. The native side synthesizes each sentence with
// a local Piper voice (src-tauri/src/voice.rs); this module plays them in order and
// estimates which word is being spoken, because the engine reports no word timings.
// A voice is downloaded only after the reader confirms it.

import { Channel, invoke } from '@tauri-apps/api/core';
import { isDesktopApp } from './desktop.js';
import { alertDialog, confirmDialog } from './dialog.js';
import { logDiagError } from './diagnostics.js';

const URI_PREFIX = 'piper:';
const TRAILING_SILENCE_S = 0.2; // the engine ends every sentence with this pause
const WORD_TICK_MS = 50;

/** True where speech goes through this module instead of Web Speech. */
export const usesDesktopVoice = isDesktopApp && /linux/i.test(navigator.userAgent);

let catalog = [];
let catalogReady = null;
let audio = null;
let run = 0;
let abortPlayback = null;

function loadCatalog() {
  catalogReady = invoke('voice_catalog').then((voices) => {
    catalog = voices;
  });
  return catalogReady;
}

if (usesDesktopVoice) loadCatalog().catch((err) => logDiagError('voice', err));

/** The voices, shaped for the Settings picker. */
export function desktopVoices() {
  return catalog.map((v) => ({
    voiceURI: URI_PREFIX + v.id,
    name: v.installed ? v.name : `${v.name} · download`,
    lang: v.lang,
    localService: true,
  }));
}

function pickVoice(lang, savedUri) {
  const base = (lang || 'en').toLowerCase().split('-')[0];
  const fits = catalog.filter((v) => v.lang.toLowerCase().split('-')[0] === base);
  const saved = fits.find((v) => URI_PREFIX + v.id === savedUri);
  return saved || fits.find((v) => v.installed) || fits[0] || null;
}

function languageName(lang) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang.split('-')[0]);
  } catch {
    return lang;
  }
}

function showProgress(message) {
  let bar = document.querySelector('.voice-download');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'app-update voice-download';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="app-update__text"></span>';
    document.body.appendChild(bar);
  }
  bar.querySelector('.app-update__text').textContent = message;
  return () => bar.remove();
}

async function ensureInstalled(voice) {
  if (voice.installed) return true;
  const size = Math.ceil(voice.downloadBytes / 1_000_000);
  const name = languageName(voice.lang);
  const accepted = await confirmDialog(
    `Download the ${name} voice to read aloud? It takes about ${size} MB and then works offline.`,
    { confirmLabel: 'Download', cancelLabel: 'Not now' },
  );
  if (!accepted) return false;
  const hide = showProgress(`Downloading the ${name} voice…`);
  try {
    const onProgress = new Channel();
    onProgress.onmessage = ({ done, total }) => {
      showProgress(`Downloading the ${name} voice… ${Math.floor((done / total) * 100)}%`);
    };
    await invoke('voice_install', { voice: voice.id, onProgress });
    await loadCatalog();
    return true;
  } finally {
    hide();
  }
}

// When each word starts, as a fraction of the sentence. Words are weighted by length
// and punctuation by the pause it usually gets.
function wordTimeline(text, lang) {
  let position = 0;
  const words = [];
  for (const part of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) {
    if (part.isWordLike) {
      words.push({ index: part.index, at: position });
      position += part.segment.length + 1;
    } else if (/[.!?…]/.test(part.segment)) position += 6;
    else if (/[,;:]/.test(part.segment)) position += 4;
  }
  return words.map((w) => ({ index: w.index, at: w.at / (position || 1) }));
}

function stopAudio() {
  abortPlayback?.();
  abortPlayback = null;
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

/** Stop speaking, including a sentence still being prepared. */
export function stopDesktopVoice() {
  run += 1;
  stopAudio();
}

// Resolves true when the sentence ends and false when it is stopped.
function playSentence(url, chunk, lang, rate, onBoundary) {
  audio ||= new Audio();
  audio.src = url;
  audio.preservesPitch = true;
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  const timeline = wordTimeline(chunk.text, lang);
  let spoken = -1;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const length = audio.duration - TRAILING_SILENCE_S;
      if (!(length > 0)) return;
      const progress = audio.currentTime / length;
      let next = spoken;
      while (next + 1 < timeline.length && timeline[next + 1].at <= progress) next += 1;
      if (next === spoken) return;
      spoken = next;
      onBoundary?.(chunk.start + timeline[next].index);
    };
    const timer = setInterval(tick, WORD_TICK_MS);
    const settle = (finish, value) => {
      clearInterval(timer);
      audio.onended = null;
      audio.onerror = null;
      abortPlayback = null;
      finish(value);
    };
    abortPlayback = () => settle(resolve, false);
    audio.onended = () => settle(resolve, true);
    audio.onerror = () => settle(reject, new Error('The sentence could not be played.'));
    audio.play().catch((err) => {
      if (abortPlayback) settle(reject, err);
    });
  });
}

async function synthesize(voice, text) {
  const wav = await invoke('voice_speak', { voice: voice.id, text });
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

/**
 * Speak sentence chunks, replacing anything already playing.
 * @param {{ text: string, start: number }[]} chunks
 * @param {string} lang
 * @param {{ rate: number, voiceUri: string, onBoundary?: (offset: number) => void }} opts
 * @returns {Promise<boolean>} whether it was spoken to the end
 */
export async function speakWithDesktopVoice(chunks, lang, { rate, voiceUri, onBoundary }) {
  stopDesktopVoice();
  const mine = run;
  const current = () => mine === run;
  const urls = new Map();
  const prepare = (voice, sentences, i) => {
    if (i >= sentences.length) return null;
    if (!urls.has(i)) {
      const url = synthesize(voice, sentences[i].text);
      url.catch(() => {}); // awaited, and reported, when its turn comes
      urls.set(i, url);
    }
    return urls.get(i);
  };
  try {
    await catalogReady;
    const voice = pickVoice(lang, voiceUri);
    if (!voice) {
      if (current()) await alertDialog(`No voice is available for ${languageName(lang)} yet.`);
      return false;
    }
    if (!(await ensureInstalled(voice)) || !current()) return false;
    const ready = catalog.find((v) => v.id === voice.id);
    const sentences = chunks.filter((c) => /[\p{L}\p{N}]/u.test(c.text));
    for (let i = 0; i < sentences.length; i += 1) {
      const url = await prepare(ready, sentences, i);
      if (!current()) return false;
      prepare(ready, sentences, i + 1); // ready before this sentence ends
      const finished = await playSentence(url, sentences[i], lang, rate, onBoundary);
      URL.revokeObjectURL(url);
      if (!finished || !current()) return false;
    }
    return current();
  } catch (err) {
    logDiagError('voice', err);
    if (current()) {
      stopAudio();
      await alertDialog(`The voice could not read this: ${err?.message || err}`);
    }
    return false;
  } finally {
    for (const url of urls.values()) {
      url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    }
  }
}
