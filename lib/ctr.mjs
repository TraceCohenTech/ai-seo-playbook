/**
 * CTR-by-position curve: load the heuristic default, or FIT one from a site's own
 * query-level Search Console rows.
 *
 * A curve is { source, label, positions: { "1": 0.28, ..., "20": 0.002 }, fit? }.
 *
 * Every curve here is a heuristic. The default (config/ctr-curve.json) is illustrative; the
 * fitted curve is the median CTR of your own queries at each rounded position, which already
 * reflects your SERP features, brand share and AI Overviews, but is still a blend across very
 * different queries. Use it to rank pages for review, not to promise clicks.
 */
import { readFileSync } from 'node:fs';

export const DEFAULT_CURVE_PATH = new URL('../config/ctr-curve.json', import.meta.url);
export const MAX_POSITION = 20;

export function loadCurve(path = DEFAULT_CURVE_PATH) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const positions = {};
  for (let p = 1; p <= MAX_POSITION; p++) {
    const v = Number(j.positions?.[p]);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`ctr curve ${path}: positions.${p} must be a fraction between 0 and 1`);
    positions[p] = v;
  }
  const isDefault = String(path) === String(DEFAULT_CURVE_PATH);
  return { source: isDefault ? 'default' : 'file', label: j.label || String(path), positions };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Pool-adjacent-violators: weighted non-increasing fit. items: [{x, y, w}] sorted by x. */
function nonIncreasing(items) {
  const blocks = [];
  for (const it of items) {
    blocks.push({ y: it.y, w: it.w, xs: [it.x] });
    while (blocks.length > 1 && blocks[blocks.length - 2].y < blocks[blocks.length - 1].y) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w, xs: [...a.xs, ...b.xs] });
    }
  }
  const out = new Map();
  for (const b of blocks) for (const x of b.xs) out.set(x, b.y);
  return out;
}

/**
 * Fit a curve from query-level rows ({clicks, impressions, position}; e.g. GSC rows with
 * dimensions ['query'] or ['page','query']). Rows below `minImpressions` are ignored (too noisy).
 * Each rounded position 1..20 with at least `minRows` rows gets the MEDIAN CTR of those rows;
 * the medians are then forced non-increasing (weighted pool-adjacent-violators). Positions
 * without enough rows are interpolated between fitted neighbours, or, at the ends, taken from
 * the fallback curve scaled to the nearest fitted point.
 *
 * Returns { usable, reason, curve }. `usable` is true when at least `minBuckets` of positions
 * 1-10 were fitted from data.
 */
export function fitCurve(rows, { minImpressions = 20, minRows = 5, minBuckets = 6, fallback = loadCurve() } = {}) {
  const buckets = new Map();
  let used = 0;
  for (const r of rows) {
    if (!(r.impressions >= minImpressions) || !(r.position >= 0.5) || r.position >= MAX_POSITION + 0.5) continue;
    const p = Math.max(1, Math.round(r.position));
    (buckets.get(p) || buckets.set(p, []).get(p)).push(r.clicks / r.impressions);
    used++;
  }
  const fitted = [...buckets.entries()].filter(([, v]) => v.length >= minRows).sort((a, b) => a[0] - b[0])
    .map(([p, v]) => ({ x: p, y: median(v), w: v.length }));
  const smooth = nonIncreasing(fitted);
  const fittedTop10 = fitted.filter((f) => f.x <= 10).length;
  const usable = fittedTop10 >= minBuckets;

  const positions = {}, detail = [];
  const xs = fitted.map((f) => f.x);
  for (let p = 1; p <= MAX_POSITION; p++) {
    const n = buckets.get(p)?.length || 0;
    if (smooth.has(p)) {
      positions[p] = smooth.get(p);
      detail.push({ position: p, rows: n, medianCtr: fitted.find((f) => f.x === p).y, ctr: positions[p], from: 'data' });
      continue;
    }
    const lo = xs.filter((x) => x < p).pop(), hi = xs.find((x) => x > p);
    let v, from;
    if (lo != null && hi != null) {
      const t = (p - lo) / (hi - lo);
      v = smooth.get(lo) + t * (smooth.get(hi) - smooth.get(lo)); from = 'interpolated';
    } else if (lo != null || hi != null) {
      const anchor = lo != null ? lo : hi;
      const scale = fallback.positions[anchor] > 0 ? smooth.get(anchor) / fallback.positions[anchor] : 1;
      v = fallback.positions[p] * scale; from = 'fallback-scaled';
      if (lo != null) v = Math.min(v, smooth.get(lo)); else v = Math.max(v, smooth.get(hi));
    } else { v = fallback.positions[p]; from = 'fallback'; }
    positions[p] = v;
    detail.push({ position: p, rows: n, medianCtr: null, ctr: v, from });
  }
  return {
    usable,
    reason: usable ? `fitted ${fitted.length} positions from ${used} query rows`
      : `only ${fittedTop10} of positions 1-10 had >= ${minRows} query rows with >= ${minImpressions} impressions (need ${minBuckets})`,
    curve: { source: 'fitted', label: 'fitted from this site: median CTR by rounded position (heuristic)', positions, fit: { rowsUsed: used, minImpressions, minRows, buckets: detail } },
  };
}

/**
 * Pick the curve for a run. mode: 'auto' (fit when the data allows, else the default file),
 * 'fit' (fit or throw), 'default', or a path to a curve JSON file with the same shape as
 * config/ctr-curve.json.
 */
export function resolveCurve(mode = 'auto', rows = [], fitOpts = {}) {
  if (mode === 'default') return { ...loadCurve(), note: 'forced by --curve default' };
  if (mode !== 'auto' && mode !== 'fit') return { ...loadCurve(mode), note: `loaded from ${mode}` };
  const fallback = loadCurve();
  const f = fitCurve(rows, { fallback, ...fitOpts });
  if (f.usable) return { ...f.curve, note: f.reason };
  if (mode === 'fit') throw new Error(`Cannot fit a CTR curve: ${f.reason}. Use --curve default or widen --days.`);
  return { ...fallback, note: `fit not possible (${f.reason}); using illustrative defaults` };
}

/** Expected CTR (fraction) at an average position, linearly interpolated; clamps to 1..20. */
export function expectedCtr(curve, position) {
  const p = Math.min(MAX_POSITION, Math.max(1, Number(position) || MAX_POSITION));
  const lo = Math.floor(p), hi = Math.ceil(p);
  if (lo === hi) return curve.positions[lo];
  return curve.positions[lo] + (p - lo) * (curve.positions[hi] - curve.positions[lo]);
}

/** Expected clicks minus actual clicks (negative when a row beats the curve). */
export function clickGap(curve, { impressions = 0, clicks = 0, position }) {
  return impressions * expectedCtr(curve, position) - clicks;
}

/** Compact, JSON-friendly description of a curve for report output. */
export function describeCurve(curve) {
  const positions = Object.fromEntries(Object.entries(curve.positions).map(([k, v]) => [k, Math.round(v * 1e5) / 1e5]));
  return { source: curve.source, label: curve.label, note: curve.note, positions };
}
