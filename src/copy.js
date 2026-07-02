// Clipboard helper + a tiny toast, used by the reader's double/triple-tap copy
// gestures (see marking.js).
//
// navigator.clipboard only exists in a secure context (https / localhost). The home
// library is read over plain http on the LAN IP (e.g. http://192.168.x.x:5173), where
// the async Clipboard API is undefined — so we fall back to the legacy hidden-textarea
// execCommand('copy'), which still works inside a user gesture in non-secure contexts.

let toastEl = null;
let toastTimer = null;

function showToast(message) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  // Reflow so re-triggering the same toast restarts the transition.
  void toastEl.offsetWidth;
  toastEl.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 1600);
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/**
 * Copy text to the clipboard and confirm with a toast. Resolves to whether it worked.
 * @param {string} text
 * @param {string} label what was copied, e.g. "Word" or "Paragraph"
 * @returns {Promise<boolean>}
 */
export async function copyWithToast(text, label) {
  const value = (text || '').trim();
  if (!value) return false;
  let ok = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = legacyCopy(value);
  showToast(ok ? `${label} copied` : 'Could not copy');
  return ok;
}
