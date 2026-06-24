// Shared prompts so the AI (Ollama) produces short, simple, plain-text
// explanations — no markdown or formatting. The reading language (the book's
// language) is configurable; the native language is for the on-demand rescue.

import { getReadingLangName } from '../settings.js';

/**
 * Explain a word in context, in simple terms of the reading language, including
 * its part of speech and (for verbs) its main forms.
 * @param {string} word
 * @param {string} sentence
 */
export function explainPrompt(word, sentence) {
  const lang = getReadingLangName();
  return (
    `You are helping someone learn ${lang}. Explain the word "${word}" as it is ` +
    `used in this sentence:\n\n"${sentence}"\n\n` +
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
 * @param {string} word
 * @param {string} sentence
 * @param {string} language native language
 */
export function explainInLanguagePrompt(word, sentence, language) {
  const reading = getReadingLangName();
  return (
    `A person learning ${reading} (native language: ${language}) needs help. ` +
    `Explain the ${reading} word "${word}" as it is used in this sentence:\n\n"${sentence}"\n\n` +
    `Answer in ${language}: start with its part of speech, then a short, simple ` +
    `explanation (one or two sentences). If it is a verb, FIRST say which form ` +
    `"${word}" is here (base, past simple, past participle, or present participle), ` +
    `then list its ${reading} forms, each labeled (base, past simple, past ` +
    `participle, present participle). ` +
    `Use plain text only — no markdown, no bullet points. Be brief.`
  );
}
