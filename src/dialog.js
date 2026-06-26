// In-app dialogs styled with the app theme, replacing the browser's native
// alert()/confirm()/prompt(). Each returns a Promise.

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.hidden = true;
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * @returns {Promise<{ confirmed: boolean, value: string }>}
 */
function openDialog({ message, withInput = false, selectOptions = null, defaultValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, hideCancel = false }) {
  const root = ensureOverlay();
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'dialog';

    const msg = document.createElement('p');
    msg.className = 'dialog__msg';
    msg.textContent = message;
    card.appendChild(msg);

    let input = null;
    if (selectOptions) {
      input = document.createElement('select');
      input.className = 'dialog__select';
      for (const { value, label } of selectOptions) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        input.appendChild(opt);
      }
      input.value = defaultValue;
      card.appendChild(input);
    } else if (withInput) {
      input = document.createElement('input');
      input.className = 'dialog__input';
      input.type = 'text';
      input.value = defaultValue;
      card.appendChild(input);
    }

    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const finish = (confirmed) => {
      root.hidden = true;
      root.replaceChildren();
      document.removeEventListener('keydown', onKey);
      resolve({ confirmed, value: input ? input.value : '' });
    };

    if (!hideCancel) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'dialog__btn';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', () => finish(false));
      actions.appendChild(cancel);
    }

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = `dialog__btn dialog__btn--primary${danger ? ' dialog__btn--danger' : ''}`;
    ok.textContent = confirmLabel;
    ok.addEventListener('click', () => finish(true));
    actions.appendChild(ok);

    card.appendChild(actions);

    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (!withInput || document.activeElement === input)) finish(true);
    };
    document.addEventListener('keydown', onKey);

    root.replaceChildren(card);
    root.hidden = false;
    root.onpointerdown = (e) => {
      if (e.target === root) finish(false); // click outside the card cancels
    };

    (input || ok).focus();
    if (input && typeof input.select === 'function') input.select();
  });
}

/** @returns {Promise<boolean>} */
export function confirmDialog(message, { confirmLabel = 'OK', danger = false } = {}) {
  return openDialog({ message, confirmLabel, danger }).then((r) => r.confirmed);
}

/** @returns {Promise<string | null>} trimmed value, or null if cancelled */
export function promptDialog(message, defaultValue = '', { confirmLabel = 'Save' } = {}) {
  return openDialog({ message, withInput: true, defaultValue, confirmLabel }).then((r) =>
    r.confirmed ? r.value.trim() : null,
  );
}

/**
 * Pick one value from a list.
 * @param {string} message
 * @param {{ value: string, label: string }[]} options
 * @param {string} defaultValue
 * @param {{ confirmLabel?: string }} [opts]
 * @returns {Promise<string | null>} the chosen value, or null if cancelled
 */
export function selectDialog(message, options, defaultValue = '', { confirmLabel = 'Save' } = {}) {
  return openDialog({ message, selectOptions: options, defaultValue, confirmLabel }).then((r) =>
    r.confirmed ? r.value : null,
  );
}

/** @returns {Promise<void>} */
export function alertDialog(message) {
  return openDialog({ message, confirmLabel: 'OK', hideCancel: true }).then(() => {});
}
