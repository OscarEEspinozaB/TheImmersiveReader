// Shared prompts so the AI (Ollama) produces short, simple, plain-text
// explanations — no markdown or formatting. The reading language (the book's
// language) is configurable; the native language is for the on-demand rescue.

import { getReadingLangName } from '../settings.js';

/**
 * Explain a word in context, in simple terms of the reading language.
 * @param {string} word
 * @param {string} sentence
 */
export function explainPrompt(word, sentence) {
  const lang = getReadingLangName();
  return (
    `You are helping someone learn ${lang}. Explain the word "${word}" as it is ` +
    `used in this sentence:\n\n"${sentence}"\n\n` +
    `Answer in simple, basic ${lang}, in one or two short sentences. ` +
    `Do not repeat the sentence. Use plain text only — no markdown, no bullet ` +
    `points, no formatting. Give only the explanation.`
  );
}

/**
 * Explain a word in context, in the user's native language.
 * @param {string} word
 * @param {string} sentence
 * @param {string} language native language
 */
export function explainInLanguagePrompt(word, sentence, language) {
  const reading = getReadingLangName();
  return (
    `A person learning ${reading} (native language: ${language}) needs help. ` +
    `Explain the ${reading} word "${word}" as it is used in this sentence:\n\n"${sentence}"\n\n` +
    `Answer in ${language}, in one or two short, simple sentences. ` +
    `Use plain text only — no markdown, no bullet points, no formatting. ` +
    `Give only the explanation.`
  );
}
