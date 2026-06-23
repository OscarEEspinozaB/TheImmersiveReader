// Vocabulary statistics derived from the (timestamped) vocabulary store.

import { listEntries, counts } from './vocabulary.js';

const DAY = 86400000;

/** @returns {{ known:number, learning:number, total:number, pctKnown:number }} */
export function summary() {
  const c = counts();
  return { ...c, pctKnown: c.total ? Math.round((c.known / c.total) * 100) : 0 };
}

/**
 * Cumulative count of Known and Learning words per day, from each word's
 * last-change timestamp. (A word sits at its last-change date in its current
 * state — good enough to visualize growth.)
 * @returns {{ day:number, known:number, learning:number }[]}
 */
export function growthSeries() {
  const items = listEntries().filter((e) => Number.isFinite(e.at));
  if (!items.length) return [];

  const known = items.filter((e) => e.state === 'known').map((e) => e.at).sort((a, b) => a - b);
  const learning = items.filter((e) => e.state === 'learning').map((e) => e.at).sort((a, b) => a - b);

  const startDay = Math.floor(Math.min(...items.map((e) => e.at)) / DAY);
  const endDay = Math.floor(Date.now() / DAY);
  // Cap the number of points so very old vocab doesn't make a huge series.
  const step = endDay - startDay > 180 ? 7 : 1;

  const points = [];
  let ki = 0;
  let li = 0;
  for (let d = startDay; d <= endDay; d += step) {
    const dayEnd = (d + step) * DAY;
    while (ki < known.length && known[ki] < dayEnd) ki += 1;
    while (li < learning.length && learning[li] < dayEnd) li += 1;
    points.push({ day: d * DAY, known: ki, learning: li });
  }
  return points;
}

/** Count of words that reached Known/Learning within the last `days` days. */
export function recent(days = 7) {
  const since = Date.now() - days * DAY;
  let known = 0;
  let learning = 0;
  for (const e of listEntries()) {
    if (e.at < since) continue;
    if (e.state === 'known') known += 1;
    else if (e.state === 'learning') learning += 1;
  }
  return { known, learning };
}
