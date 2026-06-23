// Word Swiper: a Tinder-style card game to triage vocabulary fast.
//   swipe up 👍 known · down 👎 unknown · right 🤔 learning · left ⏭ skip
// Cards follow the finger/pointer and fly out on release; keyboard arrows and
// on-screen buttons mirror the gestures. State changes use the global store.

import { setState } from './vocabulary.js';
import { getQuickDefinition, getAiDefinition } from './definitions/index.js';

const THRESHOLD = 90; // px to count as a decisive swipe

/**
 * @param {HTMLElement} root
 * @param {{ deck: { word:string, count:number, sentence:string }[], onExit: () => void }} opts
 */
export function renderSwiper(root, { deck, onExit }) {
  root.replaceChildren();
  let index = 0;
  const session = { known: 0, learning: 0, unknown: 0, skip: 0 };

  const bar = document.createElement('header');
  bar.className = 'swiper__bar';
  const exit = button('✕', 'swiper__exit', onExit);
  const progress = document.createElement('span');
  progress.className = 'swiper__progress';
  bar.append(exit, progress);

  const stage = document.createElement('div');
  stage.className = 'swiper__stage';

  const hint = document.createElement('div');
  hint.className = 'swiper__hint';
  hint.textContent = '↑ known · ↓ unknown · → learning · ← skip';

  const buttons = document.createElement('div');
  buttons.className = 'swiper__buttons';
  buttons.append(
    button('👎', 'sw-btn', () => decide('unknown')),
    button('⏭', 'sw-btn', () => decide('skip')),
    button('👍', 'sw-btn sw-btn--up', () => decide('known')),
    button('🤔', 'sw-btn', () => decide('learning')),
  );

  root.append(bar, stage, hint, buttons);

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
    stage.appendChild(buildCard(deck[index], decide));
  }

  function decide(action, fromButton = true) {
    if (index >= deck.length) return;
    const { word } = deck[index];
    if (action === 'known') {
      setState(word, 'known');
      session.known += 1;
    } else if (action === 'learning') {
      setState(word, 'learning');
      session.learning += 1;
    } else if (action === 'unknown') {
      setState(word, 'unknown');
      session.unknown += 1;
    } else {
      session.skip += 1;
    }
    index += 1;
    if (fromButton) flyOutCurrent(action);
    else showCard();
  }

  // Animate the on-screen card out, then show the next.
  function flyOutCurrent(action) {
    const card = stage.querySelector('.swipe-card');
    if (!card) {
      showCard();
      return;
    }
    const off = offsetFor(action);
    card.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    card.style.transform = `translate(${off.x}px, ${off.y}px) rotate(${off.x * 0.06}deg)`;
    card.style.opacity = '0';
    setTimeout(showCard, 220);
  }

  function showSummary() {
    updateProgress();
    const done = document.createElement('div');
    done.className = 'swiper__summary';
    done.innerHTML = `
      <h2>Done! 🎉</h2>
      <p><b>${session.known}</b> known · <b>${session.learning}</b> learning ·
         <b>${session.unknown}</b> unknown · <b>${session.skip}</b> skipped</p>`;
    const back = button('Back to library', 'sw-summary-btn', onExit);
    done.appendChild(back);
    stage.replaceChildren(done);
  }

  // Keyboard
  const onKey = (e) => {
    const map = { ArrowUp: 'known', ArrowDown: 'unknown', ArrowRight: 'learning', ArrowLeft: 'skip' };
    if (map[e.key]) {
      e.preventDefault();
      decide(map[e.key]);
    }
  };
  document.addEventListener('keydown', onKey);
  // Clean up the key listener when the view is torn down.
  root._cleanup = () => document.removeEventListener('keydown', onKey);

  showCard();

  // --- card drag (Tinder-style) ---
  function buildCard(cardData, onDecide) {
    const card = document.createElement('div');
    card.className = 'swipe-card';
    card.innerHTML = `
      <div class="swipe-card__badge"></div>
      <div class="swipe-card__word"></div>
      <div class="swipe-card__count"></div>
      <p class="swipe-card__sentence"></p>
      <button type="button" class="swipe-card__reveal">Reveal meaning</button>
      <div class="swipe-card__meaning" hidden></div>`;
    card.querySelector('.swipe-card__word').textContent = cardData.word;
    card.querySelector('.swipe-card__count').textContent =
      `appears ${cardData.count.toLocaleString()}× in this book`;
    card.querySelector('.swipe-card__sentence').textContent = cardData.sentence
      ? `“${cardData.sentence}”`
      : '';

    const badge = card.querySelector('.swipe-card__badge');
    card.querySelector('.swipe-card__reveal').addEventListener('click', (e) => {
      e.stopPropagation();
      revealMeaning(card, cardData);
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
      badge.textContent = labelFor(directionOf(dx, dy));
    });
    card.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dir = directionOf(dx, dy);
      if (dir && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        // fly out in the swipe direction, then decide
        const off = offsetFor(dir);
        card.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
        card.style.transform = `translate(${off.x}px, ${off.y}px) rotate(${off.x * 0.06}deg)`;
        card.style.opacity = '0';
        setTimeout(() => onDecide(dir, false), 220);
      } else {
        card.style.transition = 'transform 0.2s ease';
        card.style.transform = '';
        badge.textContent = '';
      }
    });

    return card;
  }
}

function revealMeaning(card, cardData) {
  const box = card.querySelector('.swipe-card__meaning');
  const btn = card.querySelector('.swipe-card__reveal');
  btn.disabled = true;
  btn.textContent = 'Looking up…';
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
  return dx > 0 ? 'learning' : 'skip';
}

function labelFor(dir) {
  return { known: '👍 known', unknown: '👎 unknown', learning: '🤔 learning', skip: '⏭ skip' }[dir] || '';
}

function offsetFor(dir) {
  const D = 600;
  return {
    known: { x: 0, y: -D },
    unknown: { x: 0, y: D },
    learning: { x: D, y: 0 },
    skip: { x: -D, y: 0 },
  }[dir] || { x: 0, y: 0 };
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
