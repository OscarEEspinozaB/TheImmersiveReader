// The read-aloud player's controls (player.js holds the state; these only show it).
// Two places, one state:
//
//   state      top bar      floating mini-player
//   idle       ▶            —
//   playing    ⏸  ⏹         ⏸  ⏹
//   paused     ▶  ⏹         ▶  ⏹
//
// ▶/⏸ is ONE button that changes with the state; ⏹ exists only while there is a
// session to stop (playing or paused). The top bar's pair is there whenever a
// document is open — ▶ from idle reads from the top of the screen. The top bar
// auto-hides while reading, so the floating pair keeps the session reachable
// without bringing the chrome back; it appears only while a session exists.

import { canPlay, getPlayerState, onPlayerChange, stopPlayer, togglePlay } from './player.js';

const ICON = {
  play: '<path d="M7 4.5v15l12.5-7.5z" />',
  pause: '<path d="M8.5 5v14" /><path d="M15.5 5v14" />',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" />',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
}

/** Wire the top bar's #player-toggle / #player-stop and create the floating pair. */
export function initPlayerControls() {
  const barToggle = document.getElementById('player-toggle');
  const barStop = document.getElementById('player-stop');

  const pill = document.createElement('div');
  pill.className = 'player-pill';
  pill.hidden = true;
  const pillToggle = document.createElement('button');
  pillToggle.type = 'button';
  pillToggle.className = 'player-pill__btn';
  const pillStop = document.createElement('button');
  pillStop.type = 'button';
  pillStop.className = 'player-pill__btn';
  pillStop.innerHTML = icon('stop');
  pillStop.title = 'Stop reading';
  pillStop.setAttribute('aria-label', 'Stop reading');
  pill.append(pillToggle, pillStop);
  document.body.appendChild(pill);

  barStop.innerHTML = icon('stop');
  for (const b of [barToggle, pillToggle]) b.addEventListener('click', togglePlay);
  for (const b of [barStop, pillStop]) b.addEventListener('click', stopPlayer);

  const render = () => {
    const ready = canPlay();
    const state = getPlayerState();
    const active = ready && state !== 'idle';
    const [name, label] =
      state === 'playing'
        ? ['pause', 'Pause reading']
        : state === 'paused'
          ? ['play', 'Resume reading']
          : ['play', 'Read aloud from the top of the page'];
    for (const b of [barToggle, pillToggle]) {
      b.innerHTML = icon(name);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.toggle('is-playing', state === 'playing');
    }
    barToggle.hidden = !ready;
    barStop.hidden = !active;
    pill.hidden = !active;
  };
  onPlayerChange(render);
  render();
}
