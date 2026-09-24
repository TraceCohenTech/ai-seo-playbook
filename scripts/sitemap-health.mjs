#!/usr/bin/env node
/**
 * Sitemap Health: are the URLs you submit actually indexable?
 *
 * A sitemap should only list 200, indexable, self-canonical URLs. Listing duplicates,
 * noindexed or redirected pages wastes crawl budget and shows up as sitemap errors (one
 * foreign-canonical story in a news sitemap was the entire "errors=1" we chased). This
 * validates each sitemap's XML, reports duplicates, then SAMPLES N URLs per sitemap and
 * checks status, X-Robots-Tag, meta robots and canonical.
 *
 * It samples and paces on purpose. Crawling thousands of your own URLs at speed can trip
 * your host's bot protection (it happened to us on Vercel), and then the audit itself becomes
 * the incident.
 *
 * Usage: node scripts/sitemap-health.mjs --sitemap https://example.com/sitemap.xml [--sitemap …] [--sample 15] [--delay-ms 1000]
 */
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: {
  sitemap: { type: 'string', multiple: true }, sample: { type: 'string', default: '15' }, 'delay-ms': { type: 'string', default: '1000' },
} });
if (!a.sitemap?.length) { console.error('Usage: node scripts/sitemap-health.mjs --sitemap https://example.com/sitemap.xml'); process.exit(1); }
const UA = 'Mozilla/5.0 (compatible; sitemap-health/1.0; +https://github.com/TraceCohenTech/ai-seo-playbook)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
let problems = 0;

for (const sm of a.sitemap) {
  const res = await fetch(sm, { headers: { 'user-agent': UA } });
  const xml = await res.text();
  const wellFormed = /^\s*<\?xml|<urlset|<sitemapindex/.test(xml) && (xml.match(/<url>/g)?.length ?? 0) === (xml.match(/<\/url>/g)?.length ?? 0);
  let urls = locs(xml);
  if (/<sitemapindex/.test(xml)) { console.log(`${sm}: sitemap index with ${urls.length} child sitemaps (pass the children directly)`); continue; }
  const dupes = urls.length - new Set(urls).size;
  console.log(`\n${sm}: HTTP ${res.status} · ${wellFormed ? 'well-formed' : 'MALFORMED'} · ${urls.length} URLs · ${dupes} duplicates`);
  if (res.status !== 200 || !wellFormed || dupes) problems++;
  urls = [...new Set(urls)].sort(() => Math.random() - 0.5).slice(0, Number(a.sample));
  for (const u of urls) {
    await sleep(Number(a['delay-ms']));
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'manual' });
      const html = r.status === 200 ? await r.text() : '';
      const xr = r.headers.get('x-robots-tag') || '';
      const meta = (html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
      const canon = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) || [])[1] || '';
      const issues = [];
      if (r.status !== 200) issues.push(`status ${r.status}${r.headers.get('location') ? ' → ' + r.headers.get('location') : ''}`);
      if (/noindex/i.test(xr)) issues.push(`X-Robots-Tag: ${xr}`);
      if (/noindex/i.test(meta)) issues.push(`meta robots: ${meta}`);
      if (canon && canon.replace(/\/$/, '') !== u.replace(/\/$/, '')) issues.push(`canonical → ${canon}`);
      if (issues.length) { problems++; console.log(`  ✗ ${u}\n      ${issues.join(' · ')}`); }
    } catch (e) { problems++; console.log(`  ✗ ${u} (${e.message})`); }
  }
  console.log(`  sampled ${urls.length}`);
}
console.log(`\n${problems ? `${problems} problem(s)` : 'all sampled URLs are 200, indexable and self-canonical'}`);
process.exit(problems ? 2 : 0);
