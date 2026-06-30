// Shared prompts so the AI (Ollama) produces short, simple, plain-text
// explanations — no markdown or formatting. The reading language (the book's
// language) is configurable; the native language is for the on-demand rescue.

import { getReadingLangName } from '../settings.js';

// Matches an apostrophe (straight or curly) anywhere in the word, which
// signals a contraction ("didn't", "you'd") or a possessive ("Dursley's").
const HAS_APOSTROPHE = /['‘’]/;

/**
 * Ask the AI to decompose a contraction into the full words it stands for,
 * choosing the right option for the context (e.g. "'d" → would/had). The reply
 * must be a single-line JSON object so it can be parsed and added to the
 * contraction registry.
 * @param {string} word the contraction surface form, e.g. "you'd"
 * @param {string} sentence
 */
export function decomposeContractionPrompt(word, sentence) {
  return (
    `In English, the contraction "${word}" appears in this sentence:\n\n"${sentence}"\n\n` +
    `Break it into the full words it stands for, choosing the correct option for ` +
    `THIS context (for example "'d" can be "would" or "had"; "'s" can be "is" or ` +
    `"has"; "'ll" is "will"). ` +
    `Reply with ONLY a JSON object on a single line, no other text, in exactly ` +
    `this form: {"parts":["word1","word2"],"note":"short nuance, or empty string"}. ` +
    `Use lowercase words.`
  );
}

/**
 * Explain a word in context, in simple terms of the reading language, including
 * its part of speech and (for verbs) its main forms.
 * @param {string} word  surface form (e.g. "Dursley's", "didn't")
 * @param {string} sentence
 */
export function explainPrompt(word, sentence) {
  const lang = getReadingLangName();
  const cliticNote = HAS_APOSTROPHE.test(word)
    ? `If "${word}" is a contraction (e.g. "didn't" = "did not", "you'd" = "you would/had") ` +
      `or a possessive (e.g. "Dursley's" = belonging to Dursley), state that first, ` +
      `then explain the base word. `
    : '';
  return (
    `You are helping someone learn ${lang}. Explain the word "${word}" as it is ` +
    `used in this sentence:\n\n"${sentence}"\n\n` +
    cliticNote +
    `Start with its part of speech (noun, verb, adjective, adverb, etc.). Then give ` +
    `a short, simple explanation in basic ${lang} (one or two sentences). ` +
    `If it is a verb, FIRST say which form "${word}" is here (e.g. base form, ` +
    `past simple, past participle, or present participle), then list its forms, ` +
    `each LABELED, like: "base: go, past simple: went, past participle: gone, ` +
    `present participle: going". ` +
    `Use plain text only — no markdown, no bullet points. Be brief.`
  );
}

/**
 * Explain a word in context, in the user's native language, including its part of
 * speech and (for verbs) its main forms.
 * @param {string} word  surface form (e.g. "Dursley's", "didn't")
 * @param {string} sentence
 * @param {string} language native language
 */
export function explainInLanguagePrompt(word, sentence, language) {
  const reading = getReadingLangName();
  const cliticNote = HAS_APOSTROPHE.test(word)
    ? `If "${word}" is a contraction or a possessive form, explain that first. `
    : '';
  return (
    `A person learning ${reading} (native language: ${language}) needs help. ` +
    `Explain the ${reading} word "${word}" as it is used in this sentence:\n\n"${sentence}"\n\n` +
    cliticNote +
    `Answer in ${language}: start with its part of speech, then a short, simple ` +
    `explanation (one or two sentences). If it is a verb, FIRST say which form ` +
    `"${word}" is here (base, past simple, past participle, or present participle), ` +
    `then list its ${reading} forms, each labeled (base, past simple, past ` +
    `participle, present participle). ` +
    `Use plain text only — no markdown, no bullet points. Be brief.`
  );
}
