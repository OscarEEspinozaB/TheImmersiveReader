// Live drag page-turn for the paged reader. The current page follows the finger
// and the adjacent page slides in from the side; releasing past a threshold
// commits the turn, otherwise it snaps back. Buttons and arrow keys route through
// next()/prev() for the same animated slide without a drag.
//
// The Paginator keeps ONE live content element (word marking is delegated on it),
// so a turn renders the incoming page into a throwaway layer, animates both, then
// commits by asking the paginator to advance: the live element re-renders to the
// destination underneath the (identical) layer, which is removed with no flash.

const DEADZONE = 12; // px of horizontal travel before a drag counts as a turn
const COMMIT_RATIO = 0.2; // fraction of the width that commits the turn on release
const SETTLE_MS = 260; // snap / complete animation duration
const EDGE_ZONE = 72; // px near the top/bottom reserved for revealing the chrome
const SIDE_ZONE = 1 / 3; // outer third of each side is a click-to-turn tap target

/**
 * @param {import('./paginator.js').Paginator} paginator
 * @param {{ surface?: HTMLElement }} [opts] `surface` is the element that listens
 *   for gestures — pass the full-width reader wrap so the empty side margins turn
 *   pages too, not only the centered text column. Defaults to the column itself.
 * @returns {{ next: () => void, prev: () => void, destroy: () => void }}
 */
export function attachPageTurn(paginator, { surface } = {}) {
  const reader = paginator.viewport; // .reader — clips the sliding layers, sets width
  const surf = surface || reader; // where gestures are listened for / captured
  const content = paginator.content; // the live (marking-bound) page

  let temp = null; // incoming-page layer (thrown away after the turn)
  let dir = 0; // -1 = next (drag left), +1 = prev (drag right)
  let width = 0;
  let startX = 0;
  let startY = 0;
  let down = false; // a pointer is pressed
  let active = false; // a horizontal turn drag is in progress
  let busy = false; // a settle/complete animation is running
  let captureId = null; // pointer id captured for the duration of a drag

  // Route every event of the dragging pointer to the surface until release. The
  // mouse has NO implicit capture (unlike touch), so without this a fast drag or one
  // that leaves the surface loses pointermove/up and the turn gets stuck mid-slide.
  // We capture only once the drag is committed, so a plain click still reaches the
  // word-marking handlers on the content element.
  const capture = (id) => {
    try {
      surf.setPointerCapture(id);
      captureId = id;
    } catch {
      /* pointer already gone */
    }
  };
  const release = () => {
    if (captureId !== null) {
      try {
        surf.releasePointerCapture(captureId);
      } catch {
        /* already released */
      }
      captureId = null;
    }
  };

  const setX = (el, x) => {
    el.style.transform = `translateX(${x}px)`;
  };

  // Mount the two sliding layers and render the incoming page. Returns false when
  // there is no page in that direction (so the gesture is ignored).
  function begin(d) {
    if (busy) return false;
    if (d < 0 && !paginator.hasNext()) return false;
    if (d > 0 && !paginator.hasPrev()) return false;
    // Abort any word-marking press the same gesture started: a page turn and a
    // dictionary lookup must never fire together. Without this the hold timer in
    // marking.js keeps running (we're about to steal the pointer via capture) and
    // fires over whatever word the turn lands on. Non-bubbling so it doesn't reach
    // this module's own pointercancel handler on .reader.
    try {
      content.dispatchEvent(new PointerEvent('pointercancel', { bubbles: false }));
    } catch {
      /* PointerEvent constructor unsupported — ignore */
    }
    dir = d;
    width = reader.clientWidth;
    temp = document.createElement('div');
    temp.className = 'reader__flow reader__turn-layer';
    reader.appendChild(temp);
    if (dir < 0) paginator.peekNext(temp);
    else paginator.peekPrev(temp);
    content.classList.add('reader__turn-layer');
    setX(content, 0);
    setX(temp, dir < 0 ? width : -width); // parked just off the screen edge
    return true;
  }

  // Follow the finger: both layers move together like a slide carousel.
  function drag(dx) {
    const d = dir < 0 ? Math.max(-width, Math.min(0, dx)) : Math.min(width, Math.max(0, dx));
    setX(content, d);
    setX(temp, dir < 0 ? width + d : -width + d);
  }

  function settle(commit) {
    busy = true;
    content.style.transition = `transform ${SETTLE_MS}ms ease`;
    temp.style.transition = `transform ${SETTLE_MS}ms ease`;
    if (commit) {
      setX(content, dir < 0 ? -width : width);
      setX(temp, 0);
    } else {
      setX(content, 0);
      setX(temp, dir < 0 ? width : -width);
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      content.removeEventListener('transitionend', finish);
      clearTimeout(timer);
      complete(commit);
    };
    const timer = setTimeout(finish, SETTLE_MS + 80); // transitionend fallback
    content.addEventListener('transitionend', finish);
  }

  function complete(commit) {
    content.style.transition = '';
    content.classList.remove('reader__turn-layer');
    content.style.transform = '';
    // Advance the paginator FIRST so the live element shows the destination page
    // under the (identical) incoming layer, then drop the layer — no flash.
    if (commit) {
      if (dir < 0) paginator.next();
      else paginator.prev();
    }
    if (temp) {
      temp.remove();
      temp = null;
    }
    dir = 0;
    active = false;
    busy = false;
  }

  // Programmatic turn (button / keyboard): a full animated slide, no drag.
  function turn(d) {
    if (busy || active || down) return;
    if (!begin(d)) return;
    // Two frames so the layers paint at their start positions before transitioning.
    requestAnimationFrame(() => requestAnimationFrame(() => settle(true)));
  }

  const onDown = (e) => {
    if (e.button !== 0 || busy) return;
    down = true;
    active = false;
    startX = e.clientX;
    startY = e.clientY;
  };

  const onMove = (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!active) {
      // Wait until the drag is decisively horizontal; bail out on a vertical one.
      if (Math.abs(dx) < DEADZONE || Math.abs(dx) <= Math.abs(dy)) {
        if (Math.abs(dy) > DEADZONE) down = false;
        return;
      }
      if (!begin(dx < 0 ? -1 : 1)) {
        down = false;
        return;
      }
      active = true;
      capture(e.pointerId);
    }
    drag(dx);
    e.preventDefault();
  };

  // A click/tap that never became a drag: turn the page Google-Books style. Zones are
  // measured against the text COLUMN so the empty side margins count too — anything
  // left of the column (or its outer-left third) goes back, anything right of it (or
  // its outer-right third) goes forward. Taps on a word (dictionary), near the top/
  // bottom edges (chrome), or in the column's center third do nothing.
  function clickTurn(e) {
    if (busy) return;
    if (Math.abs(e.clientX - startX) > DEADZONE || Math.abs(e.clientY - startY) > DEADZONE) return;
    if (e.target.closest('.word')) return;
    if (e.clientY < EDGE_ZONE || e.clientY > window.innerHeight - EDGE_ZONE) return;
    const rect = reader.getBoundingClientRect(); // the centered column
    if (e.clientX < rect.left + rect.width * SIDE_ZONE) turn(1); // left margin / third → previous
    else if (e.clientX > rect.right - rect.width * SIDE_ZONE) turn(-1); // right margin / third → next
  }

  const onUp = (e) => {
    if (!down) return;
    down = false;
    release();
    if (!active) {
      clickTurn(e);
      return;
    }
    const dx = e.clientX - startX;
    settle(Math.abs(dx) > width * COMMIT_RATIO);
  };

  const onCancel = () => {
    down = false;
    release();
    if (active) settle(false);
  };

  // A mouse drag over text/images can start a native drag-and-drop that swallows
  // our pointermove; block it so the page-turn drag is uninterrupted on desktop.
  const onDragStart = (e) => e.preventDefault();

  surf.addEventListener('pointerdown', onDown);
  surf.addEventListener('pointermove', onMove);
  surf.addEventListener('pointerup', onUp);
  surf.addEventListener('pointercancel', onCancel);
  surf.addEventListener('dragstart', onDragStart);

  return {
    next: () => turn(-1),
    prev: () => turn(1),
    destroy() {
      release();
      surf.removeEventListener('pointerdown', onDown);
      surf.removeEventListener('pointermove', onMove);
      surf.removeEventListener('pointerup', onUp);
      surf.removeEventListener('pointercancel', onCancel);
      surf.removeEventListener('dragstart', onDragStart);
      if (temp) {
        temp.remove();
        temp = null;
      }
      content.classList.remove('reader__turn-layer');
      content.style.transform = '';
      content.style.transition = '';
    },
  };
}
