// Shared prompts so the AI (Ollama) produces short, simple, plain-text
// explanations — no markdown or formatting.

/**
 * Explain a word in context, in simple English.
 * @param {string} word
 * @param {string} sentence
 */
export function explainPrompt(word, sentence) {
  return (
    `You are helping someone learn English. Explain the word "${word}" as it is ` +
    `used in this sentence:\n\n"${sentence}"\n\n` +
    `Answer in simple, basic English, in one or two short sentences. ` +
    `Do not repeat the sentence. Use plain text only — no markdown, no bullet ` +
    `points, no formatting. Give only the explanation.`
  );
}

/**
 * Explain a word in context, in the user's native language.
 * @param {string} word
 * @param {string} sentence
 * @param {string} language
 */
export function explainInLanguagePrompt(word, sentence, language) {
  return (
    `A person learning English (native language: ${language}) needs help. ` +
    `Explain the English word "${word}" as it is used in this sentence:\n\n"${sentence}"\n\n` +
    `Answer in ${language}, in one or two short, simple sentences. ` +
    `Use plain text only — no markdown, no bullet points, no formatting. ` +
    `Give only the explanation.`
  );
}
