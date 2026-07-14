// Word Swiper: a Tinder-style card game to triage + reinforce vocabulary.
//        ↑ known 👍
//   ← learning 🤔   skip ⏭ →
//        ↓ unknown 👎
// Cards follow the pointer and fly out on release; arrow keys and the on-screen
// compass mirror the gestures. State changes use the global vocabulary store.

import { setState } from './vocabulary.js';
import { getQuickDefinition, getAiDefinition } from './definitions/index.js';
import { renderKbDetails } from './kbDetails.js';

const THRESHOLD = 90; // px for a decisive swipe
const FLY = 600; // px to fling a card off-screen

const KEY_DIR = { ArrowUp: 'known', ArrowDown: 'unknown', ArrowLeft: 'learning', ArrowRight: 'skip' };
const LABEL = { known: '👍 Known', unknown: '👎 Unknown', learning: '🤔 Learning', skip: '⏭ Skip' };
const OFFSET = {
  known: { x: 0, y: -FLY },
  unknown: { x: 0, y: FLY },
  learning: { x: -FLY, y: 0 },
  skip: { x: FLY, y: 0 },
};

/**
 * @param {HTMLElement} root
 * @param {{ deck: {word,count,sentence,state}[], stats: object, onExit: () => void }} opts
 */
export function renderSwiper(root, { deck, stats, onExit }) {
  root.replaceChildren();
  let index = 0;
  const session = { known: 0, learning: 0, unknown: 0, skip: 0 };

  const bar = document.createElement('header');
  bar.className = 'swiper__bar';
  const exit = button('✕', 'swiper__exit', onExit);
  const progress = document.createElement('span');
  progress.className = 'swiper__progress';
  bar.append(exit, progress);

  const bookStats = document.createElement('div');
  bookStats.className = 'swiper__stats';
  const live = stats ? { ...stats } : null; // updated live as the user swipes
  function updateStats() {
    if (live) {
      bookStats.textContent = `${live.unknown} new · ${live.learning} learning · ${live.known} known · ${live.total} unique words in this book`;
    }
  }
  updateStats();

  const stage = document.createElement('div');
  stage.className = 'swiper__stage';

  // Compass control (mirrors the swipe directions).
  const compass = document.createElement('div');
  compass.className = 'swiper__compass';
  compass.append(
    compassBtn('known', 'up'),
    compassBtn('learning', 'left'),
    compassBtn('skip', 'right'),
    compassBtn('unknown', 'down'),
  );

  root.append(bar, bookStats, stage, compass);

  function compassBtn(action, pos) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sw-compass sw-compass--${pos}`;
    b.innerHTML = `<span class="sw-compass__arrow">${arrow(pos)}</span><span>${LABEL[action]}</span>`;
    b.addEventListener('click', () => decide(action));
    return b;
  }

  function updateProgress() {
    progress.textContent = `${Math.min(index + 1, deck.length)} / ${deck.length}`;
  }

  function showCard() {
    stage.replaceChildren();
    if (index >= deck.length) {
      showSummary();
      return;
    }
    updateProgress();
    stage.appendChild(buildCard(deck[index]));
  }

  // Walk the deck to another form of the same word (tapped in the family card):
  // "went" and "gone" belong together, so studying one and then jumping straight to
  // the other is how a paradigm is actually learned. Deciding a card still only
  // happens by swiping it — this only moves the deck, it never marks.
  const cardIndexOf = (form) => deck.findIndex((c) => c.word === form);
  const inDeck = (form) => cardIndexOf(form) !== -1;
  const jumpTo = (form) => {
    const i = cardIndexOf(form);
    if (i === -1 || i === index) return;
    index = i;
    showCard();
  };

  function decide(action, animated = true) {
    if (index >= deck.length) return;
    const card = deck[index];
    const newState = action === 'skip' ? card.state : action;
    if (newState !== card.state) {
      setState(card.word, newState);
      if (live) {
        live[card.state] = Math.max(0, (live[card.state] || 0) - 1);
        live[newState] = (live[newState] || 0) + 1;
        updateStats();
      }
      card.state = newState;
    }
    session[action] += 1;
    index += 1;

    if (animated) {
      const card = stage.querySelector('.swipe-card');
      if (card) {
        const off = OFFSET[action];
        card.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
        card.style.transform = `translate(${off.x}px, ${off.y}px) rotate(${off.x * 0.06}deg)`;
        card.style.opacity = '0';
        setTimeout(showCard, 220);
        return;
      }
    }
    showCard();
  }

  function showSummary() {
    updateProgress();
    const done = document.createElement('div');
    done.className = 'swiper__summary';
    done.innerHTML = `<h2>Done! 🎉</h2>
      <p><b>${session.known}</b> known · <b>${session.learning}</b> learning ·
         <b>${session.unknown}</b> unknown · <b>${session.skip}</b> skipped</p>`;
    done.appendChild(button('Back to library', 'sw-summary-btn', onExit));
    stage.replaceChildren(done);
  }

  const onKey = (e) => {
    if (KEY_DIR[e.key]) {
      e.preventDefault();
      decide(KEY_DIR[e.key]);
    }
  };
  document.addEventListener('keydown', onKey);
  root._cleanup = () => document.removeEventListener('keydown', onKey);

  showCard();

  function buildCard(cardData) {
    const card = document.createElement('div');
    card.className = 'swipe-card';
    card.innerHTML = `
      <div class="swipe-card__badge"></div>
      <div class="swipe-card__word word"></div>
      <div class="swipe-card__count"></div>
      <p class="swipe-card__sentence"></p>
      <button type="button" class="swipe-card__reveal">Reveal meaning</button>
      <div class="swipe-card__meaning" hidden></div>`;

    const wordEl = card.querySelector('.swipe-card__word');
    wordEl.textContent = cardData.word;
    wordEl.dataset.state = cardData.state;

    // Learning cards are the deck's point: reinforcement, not acquisition speed.
    const tag = { unknown: 'new', learning: 'reinforce', known: 'review' }[cardData.state] || cardData.state;
    card.querySelector('.swipe-card__count').textContent =
      `${tag} · appears ${cardData.count.toLocaleString()}× in this book`;
    card.querySelector('.swipe-card__sentence').textContent = cardData.sentence ? `“${cardData.sentence}”` : '';

    const badge = card.querySelector('.swipe-card__badge');
    card.querySelector('.swipe-card__reveal').addEventListener('click', (e) => {
      e.stopPropagation();
      revealMeaning(card, cardData, { onForm: jumpTo, canGo: inDeck });
    });

    let startX = 0;
    let startY = 0;
    let dragging = false;

    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.swipe-card__reveal')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      card.setPointerCapture(e.pointerId);
      card.style.transition = 'none';
    });
    card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.06}deg)`;
      badge.textContent = LABEL[directionOf(dx, dy)] || '';
    });
    card.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dir = directionOf(dx, dy);
      if (dir && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        decide(dir);
      } else {
        card.style.transition = 'transform 0.2s ease';
        card.style.transform = '';
        badge.textContent = '';
      }
    });

    return card;
  }
}

function revealMeaning(card, cardData, nav) {
  const box = card.querySelector('.swipe-card__meaning');
  const btn = card.querySelector('.swipe-card__reveal');
  btn.disabled = true;
  box.hidden = false;
  box.textContent = 'Looking up…';

  Promise.allSettled([
    getQuickDefinition(cardData.word, cardData.sentence),
    getAiDefinition(cardData.word, cardData.sentence),
  ]).then(([quick, ai]) => {
    box.textContent = '';
    const dict = quick.status === 'fulfilled' ? quick.value : null;
    const aiDef = ai.status === 'fulfilled' ? ai.value : null;
    if (dict) box.appendChild(line(dict.explanation, 'dictionary'));
    if (aiDef) box.appendChild(line(aiDef.explanation, aiDef.source));
    if (!dict && !aiDef) box.textContent = 'No definition found.';
    // The word's family, its other forms tappable when the deck holds them.
    const details = renderKbDetails(dict?.kb, cardData.word, nav);
    if (details) box.appendChild(details);
    btn.remove();
  });
}

function line(text, source) {
  const p = document.createElement('p');
  p.className = 'swipe-card__def';
  p.textContent = text;
  const s = document.createElement('span');
  s.className = 'swipe-card__src';
  s.textContent = source;
  p.appendChild(s);
  return p;
}

function directionOf(dx, dy) {
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return '';
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'known' : 'unknown';
  return dx < 0 ? 'learning' : 'skip';
}

function arrow(pos) {
  return { up: '↑', down: '↓', left: '←', right: '→' }[pos] || '';
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
