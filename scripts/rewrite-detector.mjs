#!/usr/bin/env node
/**
 * Rewrite Detector: find news stories that re-report the same event under a new slug.
 *
 * Automated news pipelines republish the same round with a reworded headline ("Encore AI
 * raises $30M for agents that learn from calls" vs "Encore AI lands $30M Series A…"). Each
 * rewrite is an indexable page competing with the original; Google calls the losers "Crawled
 * – currently not indexed". Headline matching misses them, and so does a company key built
 * from the slug's first two words, because the second word is a topic word that changes.
 *
 * This groups stories by first slug token + dollar amount and applies lib/rewrite-rules.mjs.
 * Output clusters are for REVIEW. Point each duplicate's canonical at the earliest story
 * after checking. Always simulate over your whole archive and read the clusters before
 * automating: our first rule merged Anthropic's three different IPO stories.
 *
 * Usage: node scripts/rewrite-detector.mjs --input stories.json [--window-days 7] [--output clusters.json]
 *   stories.json: [{ "slug": "encore-ai-30-million-series-a-2026", "timestamp": "2026-07-29T12:00:00Z", "amount": "$30M Series A" }, …]
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { sameRoundRewrite } from '../lib/rewrite-rules.mjs';

const { values: a } = parseArgs({ options: { input: { type: 'string' }, 'window-days': { type: 'string', default: '7' }, output: { type: 'string' } } });
if (!a.input) { console.error('Usage: node scripts/rewrite-detector.mjs --input stories.json'); process.exit(1); }
const stories = JSON.parse(readFileSync(a.input, 'utf8')).filter((s) => s.slug);
const amt = (s) => (String(s || '').match(/\$[\d,.]+\s*[BMKbmk]/) || [''])[0].toUpperCase().replace(/\s+/g, '');
const groups = new Map();
for (const s of [...stories].sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)))) {
  const m = amt(s.amount); if (!m) continue;
  const k = `${s.slug.split('-')[0]}|${m}`;
  (groups.get(k) || groups.set(k, []).get(k)).push(s);
}
const clusters = [];
for (const [key, list] of groups) {
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const c = [list[i]];
    for (let j = i + 1; j < list.length; j++) if (!used.has(j) && sameRoundRewrite(list[i], list[j], { windowDays: Number(a['window-days']) })) { c.push(list[j]); used.add(j); }
    if (c.length > 1) clusters.push({ key, canonical: c[0].slug, duplicates: c.slice(1).map((s) => s.slug) });
  }
}
console.log(`${clusters.length} clusters, ${clusters.reduce((n, c) => n + c.duplicates.length, 0)} duplicate pages (review before canonicalizing)`);
for (const c of clusters.slice(0, 25)) console.log(`  ${c.key}\n    keep ${c.canonical}\n    dup  ${c.duplicates.join('\n    dup  ')}`);
if (a.output) writeFileSync(a.output, JSON.stringify(clusters, null, 2));
