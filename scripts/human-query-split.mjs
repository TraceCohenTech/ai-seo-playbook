#!/usr/bin/env node
/**
 * Human Query Split: is your low CTR a title problem or an AI-agent problem?
 *
 * Blended CTR in 2026 is polluted by AI research agents and scrapers that generate
 * impressions but never click. This script separates each page's impressions into
 * human-shaped vs machine-shaped queries (lib/query-classifier.mjs), then flags the pages
 * that underperform FOR HUMANS: they rank on page one for human queries but earn under half
 * the site's own median human CTR at that position. Those are the only pages worth a
 * retitle. Everything else is agent traffic that no title will convert.
 *
 * Usage:
 *   node scripts/human-query-split.mjs --site sc-domain:example.com [--days 28] [--min-human-impr 300] [--output out.json]
 */
import { cli } from '../lib/cli.mjs';
import { writeFileSync } from 'node:fs';
import { gscClient, queryAll, isoDay, daysAgo } from '../lib/gsc.mjs';
import { splitQueries } from '../lib/query-classifier.mjs';

const a = cli(import.meta.url, {
  site: { type: 'string', required: true }, days: { type: 'string', default: '28' },
  'min-human-impr': { type: 'string', default: '300' }, 'path-contains': { type: 'string' }, output: { type: 'string' },
});

const sc = await gscClient();
const endDate = isoDay(daysAgo(3)), startDate = isoDay(daysAgo(3 + Number(a.days)));
const filters = a['path-contains'] ? [{ dimension: 'page', operator: 'contains', expression: a['path-contains'] }] : undefined;
const rows = await queryAll(sc, a.site, { startDate, endDate, dimensions: ['page', 'query'], filters });

const byPage = new Map();
for (const r of rows) {
  const [page, query] = r.keys;
  (byPage.get(page) || byPage.set(page, []).get(page)).push({ query, impressions: r.impressions, clicks: r.clicks, position: r.position });
}

const pages = [];
let totH = 0, totHC = 0, totM = 0, totMC = 0;
for (const [page, qs] of byPage) {
  const { human, machine } = splitQueries(qs);
  const s = (arr, k) => arr.reduce((n, x) => n + x[k], 0);
  const hi = s(human, 'impressions'), hc = s(human, 'clicks'), mi = s(machine, 'impressions'), mc = s(machine, 'clicks');
  totH += hi; totHC += hc; totM += mi; totMC += mc;
  const hpos = hi ? human.reduce((n, x) => n + x.position * x.impressions, 0) / hi : null;
  pages.push({ page, humanImpr: Math.round(hi), humanClicks: hc, humanCtr: hi ? hc / hi : 0, humanPos: hpos,
    machineImpr: Math.round(mi), machineShare: hi + mi ? mi / (hi + mi) : 0,
    topHumanQueries: human.sort((x, y) => y.impressions - x.impressions).slice(0, 3).map((x) => x.query) });
}

// The site's own expected human CTR by position (median of pages with enough human impressions).
const buckets = {};
for (const p of pages) if (p.humanImpr >= 100 && p.humanPos) (buckets[Math.min(10, Math.max(1, Math.round(p.humanPos)))] ||= []).push(p.humanCtr);
const median = (arr) => { const x = [...arr].sort((m, n) => m - n); return x.length ? x[x.length >> 1] : 0; };
const expected = Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, median(v)]));

const minH = Number(a['min-human-impr']);
const retitle = pages.filter((p) => p.humanImpr >= minH && p.humanPos && p.humanPos <= 8 && p.humanCtr < 0.5 * (expected[Math.round(p.humanPos)] || 0.01))
  .map((p) => ({ ...p, expectedCtr: expected[Math.round(p.humanPos)] || 0 }))
  .sort((x, y) => y.humanImpr * (y.expectedCtr - y.humanCtr) - x.humanImpr * (x.expectedCtr - x.humanCtr));
const agentDominated = pages.filter((p) => p.machineImpr >= 1000 && p.machineShare >= 0.8).sort((x, y) => y.machineImpr - x.machineImpr);

const pct = (x) => (100 * x).toFixed(2) + '%';
console.log(`\nWindow ${startDate}..${endDate} · ${byPage.size} pages · ${rows.length} page×query rows (visible queries only)`);
console.log(`Human-shaped:   ${Math.round(totH).toLocaleString()} impr, CTR ${pct(totHC / Math.max(totH, 1))}`);
console.log(`Machine-shaped: ${Math.round(totM).toLocaleString()} impr, CTR ${pct(totMC / Math.max(totM, 1))}`);
console.log(`\nReal retitle opportunities (human CTR < 50% of site median at that position): ${retitle.length}`);
for (const p of retitle.slice(0, 20)) console.log(`  ${p.page}\n    human ${p.humanImpr} impr · ${pct(p.humanCtr)} vs ${pct(p.expectedCtr)} expected · pos ${p.humanPos.toFixed(1)} · "${p.topHumanQueries.join('", "')}"`);
console.log(`\nAgent-dominated pages (≥80% machine impressions; a new title won't help): ${agentDominated.length}`);
for (const p of agentDominated.slice(0, 10)) console.log(`  ${p.page} · ${p.machineImpr} machine impr (${pct(p.machineShare)})`);

if (a.output) writeFileSync(a.output, JSON.stringify({ window: { startDate, endDate }, totals: { human: { impr: totH, clicks: totHC }, machine: { impr: totM, clicks: totMC } }, expectedHumanCtrByPosition: expected, retitle, agentDominated }, null, 2));
