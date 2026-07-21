// Notes shelf: renders the reader's notes (kind:'note' library records) as a list
// of text cards — title, a short preview, a relative timestamp and word count.
// A note is distinct from a book by SHAPE (a horizontal text card, never a cover)
// but shares the reading mechanic: tapping it opens it in the reader, exactly like
// a book. The only thing a note has that a book does not is editing, which lives —
// with rename, language and delete — behind the card's "⋮".

import { listNotes, renameNote, deleteBook, setBookLang, getBookContent } from './library.js';
import { confirmDialog, promptDialog, selectDialog } from './dialog.js';
import { READING_LANGUAGES, readingLangName } from './settings.js';

const sorters = {
  lastRead: (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  title: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
};

/**
 * @param {HTMLElement} container
 * @param {{ view?: 'cards'|'list', sortBy?: string, onOpen: (id: string) => void,
 *           onEdit: (id: string) => void, onNew?: () => void }} opts
 */
export async function renderNotesShelf(container, opts) {
  const { view = 'cards', sortBy = 'lastRead', onOpen, onEdit, onNew } = opts;
  const notes = await listNotes();
  notes.sort(sorters[sortBy] || sorters.lastRead);
  container.dataset.view = view;
  container.replaceChildren();

  if (notes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'shelf__empty';
    empty.textContent = 'No notes yet. Write or paste your first one.';
    container.appendChild(empty);
    if (onNew) {
      const start = document.createElement('button');
      start.className = 'shelf__sample';
      start.type = 'button';
      start.textContent = 'New note';
      start.addEventListener('click', onNew);
      container.appendChild(start);
    }
    return;
  }

  for (const note of notes) {
    container.appendChild(noteCard(note, container, opts));
  }
}

function noteCard(note, container, opts) {
  const { onOpen, onEdit } = opts;
  const reRender = () => renderNotesShelf(container, opts);

  const card = document.createElement('div');
  card.className = 'note-card';

  // The card body opens the note in the reader (same as a book).
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'note-card__open';
  open.addEventListener('click', () => onOpen(note.id));

  const title = document.createElement('span');
  title.className = 'note-card__title';
  title.textContent = note.title || 'Untitled note';
  open.appendChild(title);

  const snip = document.createElement('span');
  snip.className = 'note-card__snip';
  open.appendChild(snip);

  const meta = document.createElement('span');
  meta.className = 'note-card__meta';
  meta.textContent = relativeTime(note.lastOpenedAt || note.addedAt);
  open.appendChild(meta);

  // Preview + word count come from the content record, loaded lazily.
  fillPreview(note.id, snip, meta);

  card.appendChild(open);

  // Overflow menu: edit, rename, language, delete. Mirrors the book card's "⋮"
  // (fixed-positioned to escape the scroll container's clipping). Edit (the note's
  // text) and Rename (its title) are distinct actions, so distinct icons: a
  // pencil-in-page for editing the body, a tag for renaming.
  const edit = menuButton('Edit text', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z');
  edit.addEventListener('click', () => onEdit(note.id));

  const langLabel = note.lang ? readingLangName(note.lang) : 'not set';
  const lang = menuButton(
    `Language: ${langLabel}`,
    'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20 M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  );
  lang.addEventListener('click', async () => {
    const code = await selectDialog(
      'Note language:',
      READING_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
      note.lang || READING_LANGUAGES[0].code,
    );
    if (code) {
      await setBookLang(note.id, code);
      reRender();
    }
  });

  const rename = menuButton('Rename', 'M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01');
  rename.addEventListener('click', async () => {
    const name = await promptDialog('Note title:', note.title);
    if (name) {
      await renameNote(note.id, name);
      reRender();
    }
  });

  const del = menuButton('Delete', 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6');
  del.addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete "${note.title}"? This cannot be undone.`, {
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) {
      await deleteBook(note.id);
      reRender();
    }
  });

  const more = document.createElement('div');
  more.className = 'book__more';
  more.hidden = true;
  more.append(edit, lang, rename, del);

  const moreWrap = document.createElement('div');
  moreWrap.className = 'book__more-wrap note-card__more-wrap';
  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'book__action book__kebab';
  kebab.title = 'More actions';
  kebab.setAttribute('aria-label', 'More actions');
  kebab.textContent = '⋮';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = more.hidden;
    document.querySelectorAll('.book__more').forEach((m) => { m.hidden = true; });
    more.hidden = !willOpen;
    if (more.hidden) return;
    const r = kebab.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(r.right - more.offsetWidth, window.innerWidth - more.offsetWidth - margin));
    let top = r.top - more.offsetHeight - 4;
    if (top < margin) top = r.bottom + 4;
    more.style.left = `${left}px`;
    more.style.top = `${top}px`;
    const onDocClick = (ev) => {
      if (!moreWrap.contains(ev.target)) {
        more.hidden = true;
        document.removeEventListener('click', onDocClick);
      }
    };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  });
  moreWrap.append(kebab, more);
  card.appendChild(moreWrap);

  return card;
}

async function fillPreview(id, snip, meta) {
  const content = await getBookContent(id);
  if (!content) return;
  // Preview the clean READING text (never the raw Markdown) so the card reads the
  // way the note will be spoken — strip the leading list markers we added ("• ", "3. ").
  const preview = (content.text || '')
    .replace(/^(?:•|\d+\.)\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  snip.textContent = preview.slice(0, 160);
  const words = (content.text || '').trim().split(/\s+/).filter(Boolean).length;
  if (words) meta.textContent = `${meta.textContent} · ${words.toLocaleString()} words`;
}

// Human-friendly elapsed time: "just now", "5 min ago", "3 h ago", "Mon", or a date.
function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function menuButton(label, path) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'book__action';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path
    .split(' M')
    .map((d, i) => `<path d="${i ? 'M' : ''}${d}" />`)
    .join('')}</svg>`;
  return btn;
}
