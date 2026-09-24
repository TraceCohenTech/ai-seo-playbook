#!/usr/bin/env node
/**
 * Rewrite Measurer: did a title/content change work, relative to a matched control?
 *
 * Compares a set of changed pages over two EXPLICIT windows around the change date, and
 * compares that change with a control group of untouched pages over the same windows:
 *
 *   pre   = the --window days before --change-date
 *   gap   = --change-date and the following --exclude-days days (default 7: the change week,
 *           while Google recrawls) are EXCLUDED from both windows
 *   post  = the --window days after the gap
 *   control = untouched pages with at least --min-impressions in the pre window, whose
 *           pre-window impressions fall within the treated pages' range widened by
 *           --control-band (default 2x each way), optionally restricted by --path-contains
 *
 *   relativeLiftPct = ((treated post / treated pre) / (control post / control pre) - 1) x 100
 *
 * The control absorbs site-wide movement (seasonality, algorithm updates, growth). The verdict
 * uses a HEURISTIC +-10% band on relativeLiftPct and is marked insufficient below 10 treated
 * pages; there is no significance test, so treat small cohorts as hints.
 *
 * This replaces the old baseline/measure modes, which compared two overlapping trailing
 * windows, so "after" included pre-change days, and had no control. It uses the same
 * changes-file format as scripts/matched-control-readout.mjs.
 *
 * Usage:
 *   node scripts/rewrite-measurer.mjs --site sc-domain:example.com --change-date 2026-08-20 --pages /blog/a,/blog/b
 *   node scripts/rewrite-measurer.mjs --site sc-domain:example.com --changes changes.json --output readout.json
 *   changes.json: [{ "page": "/blog/x" | "https://www.example.com/blog/x", "changedAt": "2026-08-20", "cohort": "retitle" }, ...]
 *
 * Options:
 *   --site              Search Console property (required)
 *   --change-date       YYYY-MM-DD the change shipped (with --pages)
 *   --pages             Comma-separated paths or URLs that changed (with --change-date)
 *   --changes           JSON file of changes; one cohort per (cohort, changedAt)
 *   --window            Days in each of the pre and post windows (default 28)
 *   --exclude-days      Days from the change date excluded before the post window (default 7)
 *   --min-impressions   Minimum pre-window impressions for a page to be measured (default 100)
 *   --control-band      Control pages' pre impressions must be within [min/band, max*band] of the treated pages (default 2)
 *   --path-contains     Only use control pages whose path contains this string (e.g. /blog/)
 *   --output            Optional output JSON path
 *
 * Exit codes: 0 readout produced, 1 error (including: post window not complete yet).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, shiftDay, normPath, sumByPage, round, pct } from '../lib/gsc-rows.mjs';

export function measureWindows(changeDate, { window = 28, excludeDays = 7 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changeDate)) throw new Error(`Invalid change date "${changeDate}" (use YYYY-MM-DD)`);
  const postStart = shiftDay(changeDate, excludeDays);
  return {
    pre: { startDate: shiftDay(changeDate, -window), endDate: shiftDay(changeDate, -1) },
    excluded: { startDate: changeDate, endDate: shiftDay(postStart, -1) },
    post: { startDate: postStart, endDate: shiftDay(postStart, window - 1) },
  };
}

/** An error whose message is enough for the user (no stack trace). */
const userError = (msg) => Object.assign(new Error(msg), { user: true });

const chg = (a, b) => (a > 0 ? round((b / a - 1) * 100, 1) : null);
const view = (e) => ({ clicks: e?.clicks || 0, impressions: e?.impressions || 0, ctr: pct(e?.ctr), position: round(e?.position, 1) });

/**
 * pre/post: Map<path, agg> (sumByPage, variants summed). treated: array of paths.
 * touched: Set of every changed path (excluded from the control).
 */
export function measureCohort(pre, post, treated, touched, { minImpressions = 100, controlBand = 2, pathContains } = {}) {
  const pages = treated.map((p) => {
    const b = pre.get(p), a = post.get(p);
    const included = (b?.impressions || 0) >= minImpressions;
    return { page: p, included, pre: view(b), post: view(a), clickChangePct: chg(b?.clicks || 0, a?.clicks || 0) };
  });
  const inc = pages.filter((p) => p.included);
  const sum = (list, w, k) => list.reduce((s, p) => s + p[w][k], 0);
  const agg = (list) => {
    const c0 = sum(list, 'pre', 'clicks'), c1 = sum(list, 'post', 'clicks'), i0 = sum(list, 'pre', 'impressions'), i1 = sum(list, 'post', 'impressions');
    return { n: list.length, clicksPre: c0, clicksPost: c1, impressionsPre: i0, impressionsPost: i1, clickChangePct: chg(c0, c1), ctrPre: pct(i0 ? c0 / i0 : 0), ctrPost: pct(i1 ? c1 / i1 : 0) };
  };
  const t = agg(inc);
  let control = { n: 0 }, band = null;
  if (inc.length) {
    const imprs = inc.map((p) => p.pre.impressions);
    band = { min: Math.max(minImpressions, Math.floor(Math.min(...imprs) / controlBand)), max: Math.ceil(Math.max(...imprs) * controlBand) };
    const ctl = [];
    for (const [p, b] of pre) {
      if (touched.has(p) || b.impressions < band.min || b.impressions > band.max) continue;
      if (pathContains && !p.includes(pathContains)) continue;
      ctl.push({ pre: view(b), post: view(post.get(p)) });
    }
    control = agg(ctl);
  }
  let relativeLiftPct = null;
  if (t.clicksPre > 0 && control.clicksPre > 0 && control.clicksPost > 0) {
    relativeLiftPct = round(((t.clicksPost / t.clicksPre) / (control.clicksPost / control.clicksPre) - 1) * 100, 1);
  }
  const warnings = [];
  if (inc.length < 10) warnings.push(`only ${inc.length} treated page(s) with >= ${minImpressions} pre-window impressions: treat this as a hint, not a result`);
  if (control.n < 10) warnings.push(`only ${control.n} control page(s): widen --control-band or drop --path-contains`);
  if (pages.length > inc.length) warnings.push(`${pages.length - inc.length} changed page(s) had too little pre-window data and were not measured`);
  let verdict;
  if (relativeLiftPct == null) verdict = 'NO READOUT';
  else if (inc.length < 10 || control.n < 10) verdict = 'INSUFFICIENT DATA';
  else if (relativeLiftPct >= 10) verdict = 'LIKELY POSITIVE';
  else if (relativeLiftPct <= -10) verdict = 'LIKELY NEGATIVE';
  else verdict = 'NO CLEAR EFFECT';
  return { treated: { ...t, pages }, control: { ...control, band, pathContains: pathContains || null }, relativeLiftPct, verdict, warnings };
}

/** changes: [{ page, changedAt, cohort }] -> Map<"cohort|date", paths[]> */
export function groupChanges(changes) {
  const m = new Map();
  for (const c of changes) {
    if (!c.page || !c.changedAt) throw new Error(`Each change needs "page" and "changedAt": ${JSON.stringify(c)}`);
    const k = `${c.cohort || 'change'}|${c.changedAt}`;
    const list = m.get(k) || m.set(k, []).get(k);
    const p = normPath(c.page);
    if (!list.includes(p)) list.push(p);
  }
  return m;
}

export async function buildReport(sc, { site, changes, window = 28, excludeDays = 7, minImpressions = 100, controlBand = 2, pathContains, today = new Date(), now = new Date() }) {
  const last = await lastDataDate(sc, site, { dataState: 'final', today });
  const cohorts = groupChanges(changes);
  const touched = new Set([...cohorts.values()].flat());
  const cache = new Map();
  const pages = async (w) => {
    const k = `${w.startDate}|${w.endDate}`;
    if (!cache.has(k)) cache.set(k, sumByPage(await queryAll(sc, site, { ...w, dimensions: ['page'], dataState: 'final' })));
    return cache.get(k);
  };
  const results = [];
  for (const [k, list] of cohorts) {
    const [cohort, changeDate] = k.split('|');
    const w = measureWindows(changeDate, { window, excludeDays });
    if (w.post.endDate > last) {
      throw userError(`Cohort "${cohort}" (${changeDate}): the post window ends ${w.post.endDate} but final data runs only to ${last}. ` +
        `Re-run on or after ${shiftDay(w.post.endDate, 4)}, or shorten --window.`);
    }
    results.push({ cohort, changeDate, windows: w, ...measureCohort(await pages(w.pre), await pages(w.post), list, touched, { minImpressions, controlBand, pathContains }) });
  }
  return { generated: now.toISOString(), site, lastFinalDataDate: last, config: { window, excludeDays, minImpressions, controlBand, pathContains: pathContains || null }, cohorts: results };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    'change-date': { type: 'string' },
    pages: { type: 'string' },
    changes: { type: 'string' },
    window: { type: 'string', default: '28' },
    'exclude-days': { type: 'string', default: '7' },
    'min-impressions': { type: 'string', default: '100' },
    'control-band': { type: 'string', default: '2' },
    'path-contains': { type: 'string' },
    output: { type: 'string' },
  }, { allowPositionals: true });
  if (a._.length) {
    throw userError(`The "${a._[0]}" mode was removed: baseline/measure compared overlapping windows with no control. ` +
      'Run once after the change with --change-date YYYY-MM-DD --pages /a,/b (or --changes changes.json). See --help.');
  }
  let changes;
  if (a.changes) changes = JSON.parse(readFileSync(a.changes, 'utf8'));
  else if (a.pages && a['change-date']) changes = a.pages.split(',').map((p) => p.trim()).filter(Boolean).map((page) => ({ page, changedAt: a['change-date'], cohort: 'change' }));
  else throw userError('Pass --change-date and --pages, or --changes changes.json. See --help.');

  const sc = await gscClient();
  const r = await buildReport(sc, {
    site: a.site, changes, window: Number(a.window), excludeDays: Number(a['exclude-days']),
    minImpressions: Number(a['min-impressions']), controlBand: Number(a['control-band']), pathContains: a['path-contains'],
  });
  const f = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x}%`);
  for (const c of r.cohorts) {
    console.log(`\n## ${c.cohort}, changed ${c.changeDate}`);
    console.log(`  pre ${c.windows.pre.startDate}..${c.windows.pre.endDate} | excluded ${c.windows.excluded.startDate}..${c.windows.excluded.endDate} | post ${c.windows.post.startDate}..${c.windows.post.endDate}`);
    console.log(`  treated ${c.treated.n} pages: clicks ${c.treated.clicksPre} -> ${c.treated.clicksPost} (${f(c.treated.clickChangePct)}), CTR ${c.treated.ctrPre}% -> ${c.treated.ctrPost}%`);
    console.log(`  control ${c.control.n} pages: clicks ${c.control.clicksPre ?? 0} -> ${c.control.clicksPost ?? 0} (${f(c.control.clickChangePct)}), CTR ${c.control.ctrPre ?? 0}% -> ${c.control.ctrPost ?? 0}%`);
    console.log(`  relative lift vs control: ${f(c.relativeLiftPct)}  => ${c.verdict} (heuristic +-10% band, no significance test)`);
    for (const w of c.warnings) console.log(`  ! ${w}`);
  }
  if (a.output) { writeFileSync(a.output, JSON.stringify(r, null, 2)); console.log(`\nReport saved to ${a.output}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => {
  if (!e.user) fail(e);
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
