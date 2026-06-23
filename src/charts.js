// Minimal inline-SVG charts (no dependency), themed via CSS variables.

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/**
 * A two-line cumulative growth chart (Known + Learning over time).
 * @param {{ day:number, known:number, learning:number }[]} points
 * @returns {SVGElement}
 */
export function growthChart(points) {
  const W = 600;
  const H = 220;
  const pad = 24;
  const known = cssVar('--text');
  const learning = cssVar('--word-learning');
  const grid = cssVar('--border');

  const n = points.length;
  const maxY = Math.max(1, ...points.map((p) => Math.max(p.known, p.learning)));
  const x = (i) => pad + (n <= 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (v / maxY) * (H - 2 * pad);

  const line = (key, color) => {
    if (!n) return '';
    if (n === 1) {
      return `<circle cx="${x(0)}" cy="${y(points[0][key])}" r="3" fill="${color}" />`;
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
  };

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.innerHTML = `
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="${grid}" stroke-width="1" />
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="${grid}" stroke-width="1" />
    ${line('learning', learning)}
    ${line('known', known)}
  `;
  return svg;
}

/**
 * A donut showing the Known vs Learning split.
 * @param {number} known
 * @param {number} learning
 * @returns {SVGElement}
 */
export function splitDonut(known, learning) {
  const total = known + learning;
  const r = 42;
  const c = 2 * Math.PI * r;
  const knownLen = total ? (known / total) * c : 0;
  const knownColor = cssVar('--text');
  const learningColor = cssVar('--word-learning');
  const track = cssVar('--border');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 110 110');
  svg.setAttribute('class', 'donut');
  svg.innerHTML = `
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="${track}" stroke-width="12" />
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="${learningColor}" stroke-width="12"
            stroke-dasharray="${c} ${c}" transform="rotate(-90 55 55)" />
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="${knownColor}" stroke-width="12"
            stroke-dasharray="${knownLen} ${c}" transform="rotate(-90 55 55)" />
    <text x="55" y="60" text-anchor="middle" fill="${knownColor}" font-size="18">${total ? Math.round((known / total) * 100) : 0}%</text>
  `;
  return svg;
}
