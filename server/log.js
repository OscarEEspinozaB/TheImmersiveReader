// Tiny timestamped, colored console logger for the KB service, so the server
// screen shows each incoming query and its read-through state at a glance:
//   HAVE·ai   the word was already refined → served prebuilt
//   HAVE·raw  present but not refined yet  → a background build will follow
//   MISS      not in the KB at all
//   BUILDING  a read-through build started (Ollama is refining it now)
//   BUILT     the refined entry was just stored
//   SKIPPED   build asked for, but it was already refined
//
// Colors degrade to nothing when output is not a TTY (e.g. piped to a file).

const useColor = process.stdout.isTTY;
const C = useColor
  ? { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m' }
  : { reset: '', dim: '', red: '', green: '', yellow: '', blue: '', cyan: '' };

const time = () => new Date().toLocaleTimeString();

function clip(detail) {
  if (!detail) return '';
  const t = String(detail);
  return t.length > 70 ? `${t.slice(0, 69)}…` : t;
}

/**
 * @param {string} color one of the C color codes
 * @param {string} tag fixed-width status tag
 * @param {string} word the queried word
 * @param {string} [detail] optional trailing detail (e.g. the definition)
 */
export function kbLog(color, tag, word, detail = '') {
  const d = clip(detail);
  console.log(
    `${C.dim}${time()}${C.reset}  ${color}${tag.padEnd(9)}${C.reset} ${C.cyan}${word}${C.reset}` +
      (d ? `  ${C.dim}${d}${C.reset}` : ''),
  );
}

export { C as KB_COLORS };
