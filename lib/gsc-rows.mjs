/**
 * Pure helpers shared by the Search Console scripts: property/URL handling, summing URL
 * variants, and date windows anchored on data that actually exists.
 *
 * Why summing matters: GSC reports URL variants as separate rows (`/p` and `/p/`, `www.` and
 * bare host under a Domain property, `#fragment` jump links). They are one page. A script that
 * builds a Map keyed on the normalised path and OVERWRITES lets whichever variant comes last
 * win; on one real site that turned a +36% readout into -39%. Always aggregate with `sumRows`.
 */

/**
 * The URL origin for a property, e.g. `sc-domain:example.com` -> `https://example.com`,
 * `https://www.example.com/` -> `https://www.example.com`. Domain properties cover every host
 * (www and bare), so pass `origin` (e.g. `https://www.example.com`) when the site serves www.
 */
export function siteOrigin(site, origin) {
  if (origin) return String(origin).replace(/\/+$/, '');
  const s = String(site || '');
  if (s.startsWith('sc-domain:')) return `https://${s.slice('sc-domain:'.length).replace(/\/+$/, '')}`;
  const m = s.match(/^(https?:\/\/[^/]+)/i);
  if (m) return m[1];
  throw new Error(`Unrecognised Search Console property "${site}". Use sc-domain:example.com or https://www.example.com/`);
}

/** Path prefix of a URL-prefix property (`https://example.com/blog/` -> `/blog`), or '' for domain properties. */
export function propertyPathPrefix(site) {
  const m = String(site || '').match(/^https?:\/\/[^/]+(\/.*)?$/i);
  return m && m[1] ? m[1].replace(/\/+$/, '') : '';
}

/**
 * Canonical key for a page: path + query string, no host, no #fragment, no trailing slash
 * (except the root, which is '/'). Accepts full URLs or paths.
 */
export function normPath(url) {
  let s = String(url || '').trim();
  s = s.replace(/^https?:\/\/[^/?#]+/i, '');
  s = s.replace(/#.*$/, '');
  let [path, qs] = s.split(/\?(.*)/s);
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return qs ? `${path}?${qs}` : path;
}

/** Absolute URL for a path on a property. Handles www/URL-prefix properties without doubling slashes. */
export function pageUrl(site, pathOrUrl, origin) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const p = String(pathOrUrl || '/');
  return siteOrigin(site, origin) + (p.startsWith('/') ? p : '/' + p);
}

/**
 * Aggregate GSC rows by a key. Clicks and impressions are SUMMED; position is the
 * impression-weighted mean; ctr is recomputed. `keyFn(row)` returns the group key (a string)
 * and `labelFn(row)` the fields to keep on the group (defaults to nothing).
 * Rows are GSC API rows: { keys, clicks, impressions, ctr, position }.
 */
export function sumRows(rows, keyFn, labelFn = () => ({})) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    let e = m.get(k);
    if (!e) { e = { ...labelFn(r), clicks: 0, impressions: 0, _pw: 0, variants: new Set() }; m.set(k, e); }
    e.clicks += r.clicks || 0;
    e.impressions += r.impressions || 0;
    e._pw += (r.position || 0) * (r.impressions || 0);
    if (r.keys) e.variants.add(r.keys.join(' | '));
  }
  for (const e of m.values()) {
    e.ctr = e.impressions > 0 ? e.clicks / e.impressions : 0;
    e.position = e.impressions > 0 ? e._pw / e.impressions : 0;
    e.variantCount = e.variants.size;
    delete e._pw; delete e.variants;
  }
  return m;
}

/** Rows with dimensions ['page'] -> Map<path, {page, clicks, impressions, ctr, position, variantCount}>. */
export const sumByPage = (rows, pageIdx = 0) =>
  sumRows(rows, (r) => normPath(r.keys[pageIdx]), (r) => ({ page: normPath(r.keys[pageIdx]) }));

/** Rows with dimensions ['page','query'] (any order) -> Map<"path\tquery", {page, query, ...}>. */
export function sumByPageQuery(rows, { pageIdx = 0, queryIdx = 1 } = {}) {
  return sumRows(
    rows,
    (r) => `${normPath(r.keys[pageIdx])}\t${r.keys[queryIdx]}`,
    (r) => ({ page: normPath(r.keys[pageIdx]), query: r.keys[queryIdx] }),
  );
}

export const round = (x, d = 1) => { const f = 10 ** d; return Math.round((x || 0) * f) / f; };
export const pct = (ctr) => round((ctr || 0) * 100, 2);

// ---------------------------------------------------------------- dates

export const toDay = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
export function shiftDay(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}
/** Inclusive number of days between two ISO dates. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
/** A window of `days` days ending on (and including) `endDate`. */
export const windowEnding = (endDate, days) => ({ startDate: shiftDay(endDate, -(days - 1)), endDate });

/**
 * Last date that has data in the requested dataState. GSC's newest ~2-3 days are provisional
 * ('all' only) and 'final' data lags further, so windows ending "yesterday" come up short and
 * produce false week-over-week drops. Anchor on this instead.
 */
export async function lastDataDate(sc, site, { dataState = 'final', today = new Date(), lookbackDays = 14 } = {}) {
  const endDate = toDay(today);
  const res = await sc.searchanalytics.query({
    siteUrl: site,
    requestBody: { startDate: shiftDay(endDate, -lookbackDays), endDate, dimensions: ['date'], rowLimit: 1000, dataState },
  });
  const days = (res.data.rows || []).filter((r) => r.impressions > 0).map((r) => r.keys[0]).sort();
  if (!days.length) throw new Error(`No ${dataState} Search Console data for ${site} in the last ${lookbackDays} days.`);
  return days[days.length - 1];
}
