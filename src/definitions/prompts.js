// Prompt for the only remaining direct-to-Ollama call: contraction decomposition
// (growing the registry). The context-aware explanation prompts moved to the home
// server (server/generate/explain.js), which generates + caches them; see serverAi.js.

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
