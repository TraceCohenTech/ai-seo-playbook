#!/usr/bin/env node
/**
 * Filter Detector: after a traffic cliff, was it a sitewide filter, a demotion, or something local?
 *
 * Works offline on Search Console exports, so you can run it on data you already pulled. It compares
 * a PRE window with a POST window around the cliff date and reports, per page type, country and device:
 * impressions/day before and after, retention (post/pre), and position-when-shown before and after.
 * It also scores every page that had real traffic before the cliff (median retention, share that kept
 * more than 5%).
 *
 * Windows (calendar days, missing page-days count as 0):
 *   pre  = the --pre-days days that end --exclude days before the cliff
 *   post = from --exclude days after the cliff to the last date in the data (or --post-end)
 *   With --cliff 2026-10-19 --pre-days 17 --exclude 1: pre 2026-10-01..10-17, post 2026-10-20 onward.
 *
 * Verdicts (heuristics, not statistics; tune the thresholds for your site):
 *   NO CLIFF         overall retention >= --no-cliff (0.70)
 *   INDEXING PROBLEM --indexed-share given and below --min-indexed (0.70); fix indexing first
 *   LOCALIZED        some cohort (type, country or device) kept >= --localized-high (0.50) while another
 *                    kept <= --localized-low (0.25); the drop is concentrated, look at what differs
 *   DEMOTION         pages still shown but ranked lower: median per-page position change >= --demotion-pos (3)
 *   SITEWIDE FILTER  overall retention < --filter-max (0.20), every cohort below --cohort-max (0.25), and
 *                    position-when-shown held (median change < --demotion-pos). Uniform, and not a rank loss
 *   INCONCLUSIVE     none of the above; the report lists which test failed
 * Cohorts below --min-cohort impressions/day pre (50) are reported but ignored by the verdict.
 * A GSC export cannot prove pages are indexed. Sample URL Inspection and pass --indexed-share.
 *
 * Input files: JSONL (one row per line), a JSON array, or CSV with a header row. Columns (any case):
 *   pages file:     page (or url), date, impressions, clicks, position
 *   countries file: country, date, impressions, clicks, position
 *   devices file:   device, date, impressions, clicks, position
 * GSC API rows ({keys:[page,date], impressions, ...}) are accepted too, keys in that order.
 * Page type: first matching regex in --types (JSON [{"type":"blog","pattern":"^/blog/"}]), otherwise
 * "homepage" for "/", the host for pages on a different host than the main one, else the first path segment.
 *
 * Usage:
 *   node scripts/filter-detector.mjs --pages pages.jsonl --cliff 2026-10-19 [--countries c.csv] [--devices d.csv]
 *     [--pre-days 14] [--exclude 1] [--post-end YYYY-MM-DD] [--types types.json] [--min-page 30]
 *     [--indexed-share 0.95] [--output report.json]
 * Exit 0 on a report (any verdict), 1 on bad input.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

export const DEFAULTS = {
  preDays: 14, exclude: 1, minPage: 30, minCohort: 50,
  noCliff: 0.7, filterMax: 0.2, cohortMax: 0.25, localizedHigh: 0.5, localizedLow: 0.25,
  demotionPos: 3, minIndexed: 0.7,
};

const userError = (msg) => Object.assign(new Error(msg), { user: true });
const DAY = 86400000;
export const shiftDay = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY) + 1;
const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---------------------------------------------------------------- parsing

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const ALIASES = { url: 'page', 'top pages': 'page', pages: 'page', 'top queries': 'query', countries: 'country', devices: 'device' };
const normKey = (k) => { const l = String(k).trim().toLowerCase(); return ALIASES[l] || l; };
const num = (v) => { if (typeof v === 'number') return v; const n = Number(String(v ?? '').replace(/[,%\s]/g, '')); return Number.isFinite(n) ? n : 0; };

/** Parse JSONL, a JSON array or CSV into rows { [dim], date, impressions, clicks, position }. */
export function parseRows(text, dim) {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return [];
  let raw;
  if (t.startsWith('[')) raw = JSON.parse(t);
  else if (t.startsWith('{')) raw = t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw userError(`Line ${i + 1} is not valid JSON`); }
  });
  else {
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    const head = splitCsvLine(lines[0]).map(normKey);
    raw = lines.slice(1).map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [head[i], v])));
  }
  return raw.map((r) => {
    const o = Array.isArray(r.keys) ? { [dim]: r.keys[0], date: r.keys[1], ...r } : Object.fromEntries(Object.entries(r).map(([k, v]) => [normKey(k), v]));
    const key = o[dim], date = String(o.date ?? '').slice(0, 10);
    if (key == null || key === '' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw userError(`Every row needs "${dim}" and a YYYY-MM-DD "date": ${JSON.stringify(r).slice(0, 120)}`);
    return { key: String(key), date, impressions: num(o.impressions), clicks: num(o.clicks), position: num(o.position) };
  });
}

// ---------------------------------------------------------------- page types

/** Build a page -> type function. rules: [{ type, pattern }] tested against the path (and full URL). */
export function pageTyper(pages, rules = []) {
  const compiled = rules.map((r) => ({ type: r.type, re: new RegExp(r.pattern) }));
  const hostOf = (p) => { try { return new URL(p).host; } catch { return null; } };
  const hosts = new Map(); // path-only pages count as the main host ('')
  for (const p of pages) { const h = hostOf(p) ?? ''; hosts.set(h, (hosts.get(h) || 0) + 1); }
  const mainHost = [...hosts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return (page) => {
    const host = hostOf(page);
    const path = host ? new URL(page).pathname : page.split('?')[0];
    for (const { type, re } of compiled) if (re.test(path) || re.test(page)) return type;
    if ((host ?? '') !== mainHost) return host || 'other';
    if (path === '/' || path === '') return 'homepage';
    return path.split('/').filter(Boolean)[0] || 'homepage';
  };
}

// ---------------------------------------------------------------- analysis

export function windows(cliff, { preDays = DEFAULTS.preDays, exclude = DEFAULTS.exclude, postEnd } = {}) {
  const preEnd = shiftDay(cliff, -exclude - 1);
  return { pre: { startDate: shiftDay(preEnd, -(preDays - 1)), endDate: preEnd }, post: { startDate: shiftDay(cliff, exclude), endDate: postEnd } };
}

function aggregate(rows, w, groupOf) {
  const g = new Map();
  for (const r of rows) {
    const side = r.date >= w.pre.startDate && r.date <= w.pre.endDate ? 'pre' : r.date >= w.post.startDate && r.date <= w.post.endDate ? 'post' : null;
    if (!side) continue;
    const k = groupOf(r.key);
    const e = g.get(k) || g.set(k, { pre: { i: 0, c: 0, pw: 0 }, post: { i: 0, c: 0, pw: 0 } }).get(k);
    e[side].i += r.impressions; e[side].c += r.clicks; e[side].pw += r.position * r.impressions;
  }
  return g;
}

function summarize(name, e, preN, postN) {
  const preI = e.pre.i / preN, postI = e.post.i / postN;
  return {
    name,
    preImprPerDay: round(preI), postImprPerDay: round(postI),
    preClicksPerDay: round(e.pre.c / preN), postClicksPerDay: round(e.post.c / postN),
    retention: preI ? round(postI / preI, 4) : null,
    prePosition: e.pre.i ? round(e.pre.pw / e.pre.i) : null,
    postPosition: e.post.i ? round(e.post.pw / e.post.i) : null,
  };
}

function cohortTable(rows, w, groupOf, preN, postN) {
  return [...aggregate(rows, w, groupOf)].map(([k, e]) => summarize(k, e, preN, postN)).sort((a, b) => b.preImprPerDay - a.preImprPerDay);
}

/**
 * pages/countries/devices: parsed rows ({ key, date, impressions, clicks, position }).
 * Returns the full report including the verdict.
 */
export function analyze({ pages, countries = [], devices = [], cliff, preDays, exclude, postEnd, types = [], indexedShare, ...thresholds }) {
  const T = { ...DEFAULTS, ...Object.fromEntries(Object.entries(thresholds).filter(([, v]) => v !== undefined)) };
  preDays ??= DEFAULTS.preDays; exclude ??= DEFAULTS.exclude;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cliff || '')) throw userError('--cliff must be YYYY-MM-DD');
  if (!pages.length) throw userError('The pages file has no rows');
  const all = [...pages, ...countries, ...devices].map((r) => r.date).sort();
  const firstDate = all[0], lastDate = all[all.length - 1];
  const w = windows(cliff, { preDays, exclude, postEnd: postEnd || lastDate });
  if (w.pre.startDate < firstDate) throw userError(`The pre window starts ${w.pre.startDate} but the data starts ${firstDate}. Export more history or lower --pre-days.`);
  if (w.post.endDate < w.post.startDate) throw userError(`No data after the cliff: the post window would start ${w.post.startDate} but the data ends ${lastDate}.`);
  const preN = daysBetween(w.pre.startDate, w.pre.endDate), postN = daysBetween(w.post.startDate, w.post.endDate);
  const warnings = [];
  if (postN < 7) warnings.push(`The post window is only ${postN} days. A week or more of post-cliff data makes this more reliable.`);

  const overall = summarize('all', aggregate(pages, w, () => 'all').get('all') || { pre: { i: 0, c: 0, pw: 0 }, post: { i: 0, c: 0, pw: 0 } }, preN, postN);
  const typeOf = pageTyper(new Set(pages.map((r) => r.key)), types);
  const byType = cohortTable(pages, w, typeOf, preN, postN);
  const byCountry = cohortTable(countries, w, (k) => k.toLowerCase(), preN, postN);
  const byDevice = cohortTable(devices, w, (k) => k.toLowerCase(), preN, postN);

  // Per page: retention distribution and position change for pages shown in both windows.
  const perPage = [...aggregate(pages, w, (k) => k)].map(([k, e]) => summarize(k, e, preN, postN));
  const qualified = perPage.filter((p) => p.preImprPerDay >= T.minPage);
  const keptOver5 = qualified.filter((p) => p.retention > 0.05);
  const shownBoth = perPage.filter((p) => p.prePosition != null && p.postPosition != null && p.preImprPerDay >= 1);
  const posDelta = median(shownBoth.map((p) => p.postPosition - p.prePosition));
  const pages_ = {
    minPreImprPerDay: T.minPage,
    qualified: qualified.length,
    medianRetention: round(median(qualified.map((p) => p.retention)), 4),
    keptOver5Pct: qualified.length ? round((keptOver5.length / qualified.length) * 100) : null,
    topSurvivors: keptOver5.sort((a, b) => b.retention - a.retention).slice(0, 10).map((p) => ({ page: p.name, type: typeOf(p.name), retention: p.retention, preImprPerDay: p.preImprPerDay, postImprPerDay: p.postImprPerDay })),
    shownInBothWindows: shownBoth.length,
    medianPositionChange: round(posDelta),
  };

  const big = (t) => t.filter((c) => c.preImprPerDay >= T.minCohort && c.retention != null);
  const cohorts = [...big(byType).map((c) => ({ ...c, dim: 'type' })), ...big(byCountry).map((c) => ({ ...c, dim: 'country' })), ...big(byDevice).map((c) => ({ ...c, dim: 'device' }))];
  if (!byCountry.length || !byDevice.length) warnings.push('No country and/or device split given. Uniform retention across countries and devices is part of the filter test; pass --countries and --devices.');
  if (indexedShare == null) warnings.push('Indexing not checked. Sample URL Inspection on lost pages and pass --indexed-share (0..1).');
  const verdict = decide({ overall, cohorts, posDelta, indexedShare, T });
  return {
    cliff, windows: { ...w, preDays: preN, postDays: postN, excluded: { startDate: shiftDay(w.pre.endDate, 1), endDate: shiftDay(w.post.startDate, -1) } },
    thresholds: T, overall, byType, byCountry, byDevice, pages: pages_, indexedShare: indexedShare ?? null,
    ...verdict, warnings,
  };
}

export function decide({ overall, cohorts, posDelta, indexedShare, T = DEFAULTS }) {
  const r = overall.retention;
  const reasons = [];
  const pct = (x) => `${round(x * 100, 1)}%`;
  if (r == null) return { verdict: 'INCONCLUSIVE', reasons: ['No impressions in the pre window'] };
  reasons.push(`Overall retention ${pct(r)} (impressions/day ${overall.preImprPerDay} -> ${overall.postImprPerDay})`);
  if (r >= T.noCliff) return { verdict: 'NO CLIFF', reasons: [...reasons, `At or above ${pct(T.noCliff)}: not a cliff by this tool's definition`] };
  if (indexedShare != null && indexedShare < T.minIndexed) {
    return { verdict: 'INDEXING PROBLEM', reasons: [...reasons, `Only ${pct(indexedShare)} of sampled pages indexed (< ${pct(T.minIndexed)}). Fix indexing before reading rankings.`] };
  }
  const hi = cohorts.filter((c) => c.retention >= T.localizedHigh), lo = cohorts.filter((c) => c.retention <= T.localizedLow);
  if (hi.length && lo.length) {
    const f = (cs) => cs.map((c) => `${c.dim}:${c.name} ${pct(c.retention)}`).join(', ');
    return { verdict: 'LOCALIZED', reasons: [...reasons, `Kept traffic: ${f(hi)}`, `Lost traffic: ${f(lo)}`] };
  }
  if (posDelta != null) reasons.push(`Median position change on pages shown in both windows: ${posDelta >= 0 ? '+' : ''}${round(posDelta)}`);
  if (posDelta != null && posDelta >= T.demotionPos) {
    return { verdict: 'DEMOTION', reasons: [...reasons, `Pages are still shown but ranked >= ${T.demotionPos} positions lower`] };
  }
  const maxCohort = cohorts.reduce((m, c) => Math.max(m, c.retention), 0);
  if (cohorts.length) reasons.push(`Highest cohort retention ${pct(maxCohort)} across ${cohorts.length} cohorts`);
  if (r < T.filterMax && maxCohort < T.cohortMax && (posDelta == null || posDelta < T.demotionPos)) {
    if (posDelta == null) reasons.push('No page was shown in both windows, so position-when-shown could not be compared');
    return { verdict: 'SITEWIDE FILTER', reasons: [...reasons, 'Uniform loss across page types, countries and devices with positions held when shown'] };
  }
  const why = [];
  if (r >= T.filterMax) why.push(`overall retention ${pct(r)} is not below ${pct(T.filterMax)}`);
  if (maxCohort >= T.cohortMax) why.push(`a cohort kept ${pct(maxCohort)} (filter test needs all < ${pct(T.cohortMax)})`);
  return { verdict: 'INCONCLUSIVE', reasons: [...reasons, `Not a filter: ${why.join('; ')}`] };
}

// ---------------------------------------------------------------- CLI

function printTable(title, rows) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  console.log('  name'.padEnd(28) + 'pre impr/d'.padStart(12) + 'post impr/d'.padStart(13) + 'retention'.padStart(11) + 'pos pre'.padStart(9) + 'pos post'.padStart(10));
  for (const c of rows.slice(0, 15)) {
    console.log(`  ${String(c.name).slice(0, 25).padEnd(26)}${String(c.preImprPerDay).padStart(12)}${String(c.postImprPerDay).padStart(13)}` +
      `${(c.retention == null ? 'n/a' : (c.retention * 100).toFixed(1) + '%').padStart(11)}${String(c.prePosition ?? 'n/a').padStart(9)}${String(c.postPosition ?? 'n/a').padStart(10)}`);
  }
}

async function main() {
  const a = cli(import.meta.url, {
    pages: { type: 'string', required: true }, cliff: { type: 'string', required: true },
    countries: { type: 'string' }, devices: { type: 'string' }, types: { type: 'string' },
    'pre-days': { type: 'string' }, exclude: { type: 'string' }, 'post-end': { type: 'string' },
    'min-page': { type: 'string' }, 'min-cohort': { type: 'string' }, 'indexed-share': { type: 'string' },
    'no-cliff': { type: 'string' }, 'filter-max': { type: 'string' }, 'cohort-max': { type: 'string' },
    'localized-high': { type: 'string' }, 'localized-low': { type: 'string' }, 'demotion-pos': { type: 'string' },
    'min-indexed': { type: 'string' }, output: { type: 'string' },
  });
  const read = (f, dim) => { try { return parseRows(readFileSync(f, 'utf8'), dim); } catch (e) { if (e.user) throw userError(`${f}: ${e.message}`); throw e; } };
  const n = (k) => (a[k] === undefined ? undefined : Number(a[k]));
  for (const k of ['pre-days', 'exclude', 'min-page', 'min-cohort', 'indexed-share', 'no-cliff', 'filter-max', 'cohort-max', 'localized-high', 'localized-low', 'demotion-pos', 'min-indexed']) {
    if (a[k] !== undefined && !Number.isFinite(Number(a[k]))) throw userError(`--${k} must be a number`);
  }
  const r = analyze({
    pages: read(a.pages, 'page'), countries: a.countries ? read(a.countries, 'country') : [], devices: a.devices ? read(a.devices, 'device') : [],
    cliff: a.cliff, preDays: n('pre-days'), exclude: n('exclude'), postEnd: a['post-end'],
    types: a.types ? JSON.parse(readFileSync(a.types, 'utf8')) : [], indexedShare: n('indexed-share'),
    minPage: n('min-page'), minCohort: n('min-cohort'), noCliff: n('no-cliff'), filterMax: n('filter-max'), cohortMax: n('cohort-max'),
    localizedHigh: n('localized-high'), localizedLow: n('localized-low'), demotionPos: n('demotion-pos'), minIndexed: n('min-indexed'),
  });
  console.log(`filter-detector: cliff ${r.cliff} | pre ${r.windows.pre.startDate}..${r.windows.pre.endDate} (${r.windows.preDays}d) | post ${r.windows.post.startDate}..${r.windows.post.endDate} (${r.windows.postDays}d)`);
  printTable('By page type', r.byType);
  printTable('By country', r.byCountry);
  printTable('By device', r.byDevice);
  const p = r.pages;
  console.log(`\nPages with >= ${p.minPreImprPerDay} impressions/day before: ${p.qualified}; median retention ${p.medianRetention == null ? 'n/a' : (p.medianRetention * 100).toFixed(1) + '%'}; kept > 5%: ${p.keptOver5Pct ?? 'n/a'}%`);
  console.log(`Pages shown in both windows: ${p.shownInBothWindows}; median position change ${p.medianPositionChange ?? 'n/a'}`);
  console.log(`\nVERDICT: ${r.verdict}`);
  for (const x of r.reasons) console.log(`  - ${x}`);
  for (const x of r.warnings) console.log(`  ! ${x}`);
  if (a.output) { writeFileSync(a.output, JSON.stringify(r, null, 2)); console.log(`\nReport saved to ${a.output}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => {
  if (!e.user) fail(e);
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
