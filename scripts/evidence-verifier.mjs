#!/usr/bin/env node
/**
 * Evidence Verifier: every published fact needs a quote that is actually on the source page.
 *
 * AI answer engines (ChatGPT, Perplexity, Claude, Google AI Overviews) cite pages they trust.
 * Trust comes from facts that check out. If you use LLM agents to research facts, never
 * trust their "verbatim" quotes: their web tools return model-processed text, so quotes
 * drift, and a model can launder an unsourced number into a confident sentence. This
 * re-fetches every source URL and accepts a fact only if:
 *   - verbatim: the normalized quote appears on the page, or
 *   - near-verbatim: the page contains the fact's figure within a 700-char window that also
 *     holds >= 75% of the quote's content words.
 * AND the figure in `value` appears inside the quote. Anything else is rejected, not guessed.
 * On our first run about half an agent batch's fields failed; the failures were real errors
 * (a wrong round date, invented investors, a figure attributed to the wrong company).
 *
 * Usage: node scripts/evidence-verifier.mjs --input evidence.json [--output report.json]
 *   evidence.json: [{ "id": "acme.valuation", "value": "$1.2B", "url": "https://…", "quote": "…valued at $1.2 billion…" }, …]
 */
import { cli } from '../lib/cli.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const a = cli(import.meta.url, { input: { type: 'string', required: true }, output: { type: 'string' }, blocklist: { type: 'string', default: 'pitchbook|crunchbase|tracxn|cbinsights|linkedin\\.com' } });
const BLOCKED = new RegExp(a.blocklist, 'i');
const norm = (s) => String(s).normalize('NFKC').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;|[‘’]/g, "'").replace(/&quot;|&ldquo;|&rdquo;|[“”]/g, '"')
  .replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').toLowerCase().trim();
const figures = (v) => (String(v).match(/\d[\d,.]*/g) || []).map((x) => x.replace(/,/g, '').replace(/\.0+$/, ''));
const cache = new Map();
async function page(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (evidence-verifier)' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
      .then(async (r) => (r.ok ? norm(await r.text()) : `__HTTP_${r.status}`)).catch((e) => `__ERR_${e.name}`));
  }
  return cache.get(url);
}
function nearVerbatim(body, quote, value) {
  const words = [...new Set(quote.replace(/[^a-z0-9$.% ]/g, ' ').split(' ').filter((w) => w.length > 3))];
  if (words.length < 4) return false;
  const flat = body.replace(/,/g, '');
  const anchors = figures(value).length ? figures(value) : words.slice().sort((x, y) => y.length - x.length).slice(0, 2);
  for (const an of anchors) for (let i = flat.indexOf(an), n = 0; i !== -1 && n < 30; i = flat.indexOf(an, i + 1), n++) {
    const win = flat.slice(Math.max(0, i - 350), i + 350);
    if (words.filter((w) => win.includes(w.replace(/,/g, ''))).length / words.length >= 0.75) return true;
  }
  return false;
}
const items = JSON.parse(readFileSync(a.input, 'utf8'));
const results = [];
for (const ev of items) {
  const why = [];
  if (BLOCKED.test(ev.url)) why.push('blocked source (paywalled/ToS; cite a primary source instead)');
  const body = await page(ev.url), q = norm(ev.quote || '');
  let tier = null;
  if (body.startsWith('__')) why.push(`fetch failed (${body.slice(2)})`);
  else if (q && body.includes(q)) tier = 'verbatim';
  else if (q && nearVerbatim(body, q, ev.value)) tier = 'near-verbatim';
  else why.push('quote not found on page');
  const figs = figures(ev.value);
  if (figs.length && !figs.some((f) => q.replace(/,/g, '').includes(f))) why.push('figure not inside the quote');
  results.push({ ...ev, ok: !why.length, tier: why.length ? null : tier, why });
  console.log(`${why.length ? '✗' : '✓'} ${ev.id || ev.url}${why.length ? ' — ' + why.join('; ') : ` (${tier})`}`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} facts verified`);
if (a.output) writeFileSync(a.output, JSON.stringify(results, null, 2));
process.exit(pass === results.length ? 0 : 2);
