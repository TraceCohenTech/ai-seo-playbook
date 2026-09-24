#!/usr/bin/env node
/**
 * GSC Title Rewrite Candidate Finder
 *
 * Finds pages with title-rewrite potential: enough impressions, a low CTR, and an average
 * position where a better title plausibly matters. Every threshold is a flag. For each
 * candidate it lists the top queries, a rough intent mix, the share of impressions from
 * machine-shaped queries (lib/query-classifier.mjs), a heuristic score and a diagnosis.
 *
 * Machine-shaped queries (AI research agents, scrapers, SEO tools) rarely click, so a page whose
 * impressions are mostly machine queries is probably not a title problem. --human-only
 * recomputes each page's clicks/impressions/CTR/position from human-shaped queries only before
 * applying the thresholds. Note that page+query rows omit anonymised queries, so human-only
 * totals are lower than the page totals.
 *
 * Usage:
 *   node scripts/gsc-rewrite-candidates.mjs --site sc-domain:example.com
 *   node scripts/gsc-rewrite-candidates.mjs --site sc-domain:example.com --human-only --min-impressions 500
 *
 * Options:
 *   --site               Search Console property (required)
 *   --min-impressions    Minimum page impressions (default 1000)
 *   --max-ctr            Maximum CTR as a fraction (default 0.02 = 2%)
 *   --min-position       Minimum average position (default 4)
 *   --max-position       Maximum average position (default 20)
 *   --machine-threshold  Machine-query impression share above which the diagnosis says a title
 *                        rewrite is unlikely to help, and the score is reduced (default 0.5)
 *   --top-queries        Queries listed per candidate (default 10)
 *   --human-only         Judge pages on human-shaped queries only
 *   --days               Window, ending on the last final-data date (default 28)
 *   --output             Output JSON path (default rewrite-candidates.json)
 *
 * Output (JSON): { generated, site, period, config, totalPagesAnalyzed, candidatesFound,
 *   candidates: [{ page, clicks, impressions, ctr, position, rewriteScore, machineShare,
 *   topQueries, queryIntents: { counts, impressions }, diagnosis }] }. ctr values are percentages. The score is a
 *   heuristic for ordering the list; it is not a prediction.
 *
 * Exit codes: 0 finished, 1 error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';
import { gscClient, queryAll } from '../lib/gsc.mjs';
import { lastDataDate, windowEnding, sumByPage, sumByPageQuery, round, pct } from '../lib/gsc-rows.mjs';
import { isHumanQuery, isZeroClickAgent } from '../lib/query-classifier.mjs';

export const isMachineQuery = (q) => !isHumanQuery(q.query) || isZeroClickAgent(q);

export function intentOf(q) {
  const s = q.query.toLowerCase();
  if (isMachineQuery(q)) return 'machine';
  if (/\bvs\b|compare|best|top \d|ranked|alternative/.test(s)) return 'comparison';
  if (/\bbuy\b|pricing|cost|how to get|sign up|free trial/.test(s)) return 'transactional';
  if (/\b(what|how|why|when|is|are|does)\b/.test(s)) return 'informational';
  return 'navigational';
}

/** Query counts per intent, and impressions per intent. */
export function classifyQueries(queries) {
  const intents = { informational: 0, comparison: 0, transactional: 0, navigational: 0, machine: 0 };
  const impressions = { ...intents };
  for (const q of queries) { const i = intentOf(q); intents[i]++; impressions[i] += q.impressions; }
  return { counts: intents, impressions };
}

/** Heuristic ordering score. page: { impressions, ctr (fraction), position }. */
export function scoreRewritePotential(page, machineShare, { machineThreshold = 0.5 } = {}) {
  let score = Math.log10(Math.max(1, page.impressions)) * 20;
  if (page.position <= 10) score += 30; else if (page.position <= 15) score += 15;
  if (page.ctr < 0.005) score += 20; else if (page.ctr < 0.01) score += 10;
  if (machineShare > machineThreshold) score -= 40;
  return Math.round(score);
}

export function diagnose(page, intents, machineShare, { machineThreshold = 0.5 } = {}) {
  if (machineShare > machineThreshold) {
    return `${Math.round(machineShare * 100)}% of query impressions look machine-generated (AI agents, scrapers); a title rewrite is unlikely to change clicks.`;
  }
  const humanImpr = Object.entries(intents.impressions).filter(([k]) => k !== 'machine').reduce((t, [, v]) => t + v, 0);
  if (humanImpr > 0 && intents.impressions.comparison / humanImpr > 0.5) return 'Most human query impressions have comparison intent: check whether the title signals a comparison or ranking.';
  if (page.clicks === 0 && page.impressions > 50000) return 'Zero clicks at 50K+ impressions: check the live SERP (AI Overview, featured snippet, or a query mismatch) before rewriting.';
  if (page.position <= 5 && page.ctr < 0.01) return 'Top-5 position with under 1% CTR: check whether the title or snippet already answers the query in full (heuristic).';
  return null;
}

/**
 * pages: Map from sumByPage; pageQueries: Map from sumByPageQuery.
 * Returns { candidates, analyzed }.
 */
export function findCandidates(pages, pageQueries, {
  minImpressions = 1000, maxCtr = 0.02, minPosition = 4, maxPosition = 20,
  machineThreshold = 0.5, topQueries = 10, humanOnly = false,
} = {}) {
  const qByPage = new Map();
  for (const q of pageQueries.values()) (qByPage.get(q.page) || qByPage.set(q.page, []).get(q.page)).push(q);

  const candidates = [];
  let analyzed = 0;
  for (const p of pages.values()) {
    analyzed++;
    const qs = (qByPage.get(p.page) || []).sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
    const machineImpr = qs.filter(isMachineQuery).reduce((s, q) => s + q.impressions, 0);
    const qImpr = qs.reduce((s, q) => s + q.impressions, 0);
    const machineShare = qImpr > 0 ? machineImpr / qImpr : 0;
    let m = p;
    if (humanOnly) {
      const human = qs.filter((q) => !isMachineQuery(q));
      const impressions = human.reduce((s, q) => s + q.impressions, 0);
      const clicks = human.reduce((s, q) => s + q.clicks, 0);
      const pw = human.reduce((s, q) => s + q.position * q.impressions, 0);
      m = { page: p.page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? pw / impressions : 0 };
    }
    if (!(m.impressions >= minImpressions && m.ctr <= maxCtr && m.position >= minPosition && m.position <= maxPosition)) continue;
    const listed = (humanOnly ? qs.filter((q) => !isMachineQuery(q)) : qs);
    const intents = classifyQueries(listed);
    candidates.push({
      page: p.page, clicks: m.clicks, impressions: m.impressions, ctr: pct(m.ctr), position: round(m.position, 1),
      rewriteScore: scoreRewritePotential(m, machineShare, { machineThreshold }),
      machineShare: round(machineShare, 2),
      topQueries: listed.slice(0, topQueries).map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: pct(q.ctr), position: round(q.position, 1), machine: isMachineQuery(q) })),
      queryIntents: intents,
      diagnosis: diagnose(m, intents, machineShare, { machineThreshold }),
    });
  }
  candidates.sort((a, b) => b.rewriteScore - a.rewriteScore || b.impressions - a.impressions);
  return { candidates, analyzed };
}

export async function buildReport(sc, opts) {
  const { site, days = 28, today = new Date(), now = new Date() } = opts;
  const end = await lastDataDate(sc, site, { dataState: 'final', today });
  const period = windowEnding(end, days);
  const pages = sumByPage(await queryAll(sc, site, { ...period, dimensions: ['page'], dataState: 'final' }));
  const pageQueries = sumByPageQuery(await queryAll(sc, site, { ...period, dimensions: ['page', 'query'], dataState: 'final' }));
  const config = {
    minImpressions: opts.minImpressions ?? 1000, maxCtr: opts.maxCtr ?? 0.02, minPosition: opts.minPosition ?? 4,
    maxPosition: opts.maxPosition ?? 20, machineThreshold: opts.machineThreshold ?? 0.5, topQueries: opts.topQueries ?? 10,
    humanOnly: !!opts.humanOnly, days,
  };
  const { candidates, analyzed } = findCandidates(pages, pageQueries, config);
  return { generated: now.toISOString(), site, period, config, totalPagesAnalyzed: analyzed, candidatesFound: candidates.length, candidates };
}

async function main() {
  const a = cli(import.meta.url, {
    site: { type: 'string', required: true },
    'min-impressions': { type: 'string', default: '1000' },
    'max-ctr': { type: 'string', default: '0.02' },
    'min-position': { type: 'string', default: '4' },
    'max-position': { type: 'string', default: '20' },
    'machine-threshold': { type: 'string', default: '0.5' },
    'top-queries': { type: 'string', default: '10' },
    'human-only': { type: 'boolean', default: false },
    days: { type: 'string', default: '28' },
    output: { type: 'string', default: 'rewrite-candidates.json' },
  });
  const sc = await gscClient();
  const r = await buildReport(sc, {
    site: a.site, days: Number(a.days), minImpressions: Number(a['min-impressions']), maxCtr: Number(a['max-ctr']),
    minPosition: Number(a['min-position']), maxPosition: Number(a['max-position']),
    machineThreshold: Number(a['machine-threshold']), topQueries: Number(a['top-queries']), humanOnly: a['human-only'],
  });
  writeFileSync(a.output, JSON.stringify(r, null, 2));
  console.log(`\nRewrite candidates for ${a.site}, ${r.period.startDate} -> ${r.period.endDate}${r.config.humanOnly ? ' (human-shaped queries only)' : ''}`);
  console.log(`${r.candidatesFound} of ${r.totalPagesAnalyzed} pages qualify.\n`);
  if (!r.candidatesFound) console.log('No candidates. Adjust --min-impressions, --max-ctr or the position range.');
  console.log('Score  Impr       CTR    Pos   Machine  Page');
  for (const c of r.candidates.slice(0, 15)) {
    console.log(`${String(c.rewriteScore).padStart(5)}  ${c.impressions.toLocaleString().padStart(9)}  ${`${c.ctr}%`.padStart(6)}  ${String(c.position).padStart(5)}  ${`${Math.round(c.machineShare * 100)}%`.padStart(7)}  ${c.page}`);
    if (c.diagnosis) console.log(`       -> ${c.diagnosis}`);
  }
  console.log(`\nFull results: ${a.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(fail);
