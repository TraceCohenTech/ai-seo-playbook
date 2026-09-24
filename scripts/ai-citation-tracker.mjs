#!/usr/bin/env node

/**
 * AI Citation Tracker (sampled measurement, official APIs only)
 *
 * Sends each of your prompts to an AI answer engine through its official
 * API and records whether your domain appears in the answer's citations.
 * It does not scrape perplexity.ai, google.com or any other web UI.
 *
 * Providers:
 *   perplexity  Perplexity Sonar API (POST https://api.perplexity.ai/chat/completions).
 *               Needs PERPLEXITY_API_KEY. Citations are read from the response's
 *               `citations` array (URLs), falling back to `search_results[].url`.
 *   openai      OpenAI Responses API with the `web_search` tool
 *               (POST https://api.openai.com/v1/responses). Needs OPENAI_API_KEY.
 *               Citations are the `url_citation` annotations on the output text.
 *
 * How a citation is counted: a cited URL counts when its host equals --domain
 * exactly, ignoring a leading "www." on either side (so example.com matches
 * www.example.com but not blog.example.com or notexample.com). Pass
 * --include-subdomains to also count *.example.com.
 *
 * What the numbers mean: this is a SAMPLED MEASUREMENT. Each prompt is sent
 * once per provider, on one date, through the API. API answers can differ from
 * the consumer apps, and answers vary between runs, users and locations. Treat
 * the citation rate as a trend indicator across repeated runs with the same
 * prompts, not as a complete measure of AI visibility. Every result records
 * the provider, the model, the timestamp and the exact prompt.
 *
 * A non-2xx API response (or network failure) is recorded as an ERROR, never
 * as "not cited", and errors are excluded from the citation rate.
 *
 * Usage:
 *   PERPLEXITY_API_KEY=… node scripts/ai-citation-tracker.mjs --domain example.com --queries prompts.txt
 *   OPENAI_API_KEY=… node scripts/ai-citation-tracker.mjs --domain example.com --queries prompts.txt --provider openai
 *   node scripts/ai-citation-tracker.mjs --domain example.com --site sc-domain:example.com --top-n 20 --output citations.json
 *
 * Options:
 *   --domain HOST          Your domain, e.g. example.com (required).
 *   --queries FILE         Prompts, one per line (# comments allowed).
 *   --site PROPERTY        Instead of --queries, use the top --top-n GSC queries by
 *                          impressions over the last 28 days of final data. Note
 *                          these are search keywords, not conversational prompts.
 *   --top-n N              Number of GSC queries to use (default 30).
 *   --provider LIST        perplexity, openai, or perplexity,openai (default perplexity).
 *   --perplexity-model M   Default "sonar".
 *   --openai-model M       Default "gpt-4.1-mini" (must support the web_search tool).
 *   --include-subdomains   Count citations on subdomains of --domain.
 *   --delay MS             Pause between API calls (default 1000).
 *   --timeout MS           Per-request timeout in milliseconds (default 60000).
 *   --output FILE          Write the JSON report to FILE.
 *   --help                 Show this help.
 *
 * Output: a console summary per provider and, with --output, a JSON report
 * with one record per (provider, prompt): provider, model, date, prompt,
 * status (cited | not_cited | error), matched citation URLs, all citations.
 *
 * Exit codes:
 *   0  every query completed (cited or not)
 *   1  error: bad usage, a missing API key, or at least one API call failed
 */

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cli, fail } from '../lib/cli.mjs';

export const PROVIDERS = {
  perplexity: { env: 'PERPLEXITY_API_KEY', defaultModel: 'sonar' },
  openai: { env: 'OPENAI_API_KEY', defaultModel: 'gpt-4.1-mini' },
};

const normHost = (h) => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** True when `url`'s host is `domain` (www-insensitive), or a subdomain when includeSubdomains. */
export function hostMatches(url, domain, includeSubdomains = false) {
  let host;
  try { host = normHost(new URL(url).hostname); } catch { return false; }
  const d = normHost(domain.replace(/^https?:\/\//i, '').split('/')[0]);
  return host === d || (includeSubdomains && host.endsWith('.' + d));
}

/** Extract citation URLs from a Perplexity chat/completions response body. */
export function perplexityCitations(body) {
  if (Array.isArray(body?.citations) && body.citations.length) return body.citations.filter((u) => typeof u === 'string');
  if (Array.isArray(body?.search_results)) return body.search_results.map((r) => r?.url).filter((u) => typeof u === 'string');
  return [];
}

/** Extract url_citation annotations from an OpenAI Responses API body. */
export function openaiCitations(body) {
  const urls = [];
  for (const item of body?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      for (const a of part?.annotations || []) if (a?.type === 'url_citation' && typeof a.url === 'string') urls.push(a.url);
    }
  }
  return urls;
}

async function postJson(url, apiKey, payload, { fetchImpl, timeoutMs }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep raw text */ }
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.httpStatus = res.status;
    throw err;
  }
  return JSON.parse(text);
}

/** Run one prompt against one provider. Never throws; failures become status 'error'. */
export async function runQuery(provider, prompt, { apiKey, model, domain, includeSubdomains = false, fetchImpl = fetch, timeoutMs = 60000, now = () => new Date() }) {
  const record = { provider, model, date: now().toISOString(), prompt };
  try {
    let body;
    let citations;
    if (provider === 'perplexity') {
      body = await postJson('https://api.perplexity.ai/chat/completions', apiKey, { model, messages: [{ role: 'user', content: prompt }] }, { fetchImpl, timeoutMs });
      citations = perplexityCitations(body);
    } else if (provider === 'openai') {
      body = await postJson('https://api.openai.com/v1/responses', apiKey, { model, input: prompt, tools: [{ type: 'web_search' }] }, { fetchImpl, timeoutMs });
      citations = openaiCitations(body);
      record.webSearchCalled = (body.output || []).some((o) => o?.type === 'web_search_call');
    } else {
      throw new Error(`unknown provider ${provider}`);
    }
    if (body?.model) record.modelReturned = body.model;
    const unique = [...new Set(citations)];
    const matched = unique.filter((u) => hostMatches(u, domain, includeSubdomains));
    return { ...record, status: matched.length ? 'cited' : 'not_cited', matchedCitations: matched, citationCount: unique.length, citations: unique };
  } catch (e) {
    return { ...record, status: 'error', error: e.name === 'TimeoutError' ? 'TIMEOUT' : e.message, ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}) };
  }
}

/** Summarise records per provider. Errors are excluded from the rate. */
export function summarize(records) {
  const out = {};
  for (const r of records) {
    const s = (out[r.provider] ??= { model: r.model, queries: 0, completed: 0, cited: 0, notCited: 0, errors: 0, citationRate: null });
    s.queries++;
    if (r.status === 'error') s.errors++;
    else { s.completed++; if (r.status === 'cited') s.cited++; else s.notCited++; }
  }
  for (const s of Object.values(out)) s.citationRate = s.completed ? Math.round((s.cited / s.completed) * 1000) / 10 : null;
  return out;
}

export async function runTracker({ prompts, domain, providers, models, keys, includeSubdomains = false, delayMs = 1000, timeoutMs = 60000, fetchImpl = fetch, onResult }) {
  const records = [];
  for (const provider of providers) {
    for (const prompt of prompts) {
      if (records.length && delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const r = await runQuery(provider, prompt, { apiKey: keys[provider], model: models[provider], domain, includeSubdomains, fetchImpl, timeoutMs });
      records.push(r);
      onResult?.(r);
    }
  }
  return {
    generated: new Date().toISOString(),
    measurement: 'Sampled measurement: each prompt sent once per provider via the official API on the date shown. Answers vary between runs, users and locations, and API answers can differ from consumer apps. Errors are excluded from the citation rate.',
    domain,
    matchRule: includeSubdomains ? 'host equals domain or is a subdomain (www-insensitive)' : 'host equals domain (www-insensitive)',
    summary: summarize(records),
    results: records,
  };
}

async function promptsFromGsc(site, topN) {
  const { gscClient, queryAll, isoDay, daysAgo } = await import('../lib/gsc.mjs');
  const sc = await gscClient();
  // GSC's newest ~3 days are provisional: use the 28 days ending 3 days ago.
  const rows = await queryAll(sc, site, { startDate: isoDay(daysAgo(30)), endDate: isoDay(daysAgo(3)), dimensions: ['query'], dataState: 'final' });
  return rows.sort((a, b) => b.impressions - a.impressions).slice(0, topN).map((r) => r.keys[0]);
}

async function main() {
  const args = cli(import.meta.url, {
    domain: { type: 'string', required: true },
    queries: { type: 'string' },
    site: { type: 'string' },
    'top-n': { type: 'string', default: '30' },
    provider: { type: 'string', default: 'perplexity' },
    'perplexity-model': { type: 'string', default: PROVIDERS.perplexity.defaultModel },
    'openai-model': { type: 'string', default: PROVIDERS.openai.defaultModel },
    'include-subdomains': { type: 'boolean', default: false },
    delay: { type: 'string', default: '1000' },
    timeout: { type: 'string', default: '60000' },
    output: { type: 'string' },
  });
  if (!args.queries === !args.site) { console.error('Error: provide exactly one of --queries FILE or --site PROPERTY.'); process.exit(1); }
  const providers = [...new Set(args.provider.split(',').map((p) => p.trim()).filter(Boolean))];
  const unknown = providers.filter((p) => !PROVIDERS[p]);
  if (!providers.length || unknown.length) { console.error(`Error: unknown provider(s): ${unknown.join(', ') || '(none)'}. Use perplexity and/or openai.`); process.exit(1); }
  const keys = {};
  for (const p of providers) {
    keys[p] = process.env[PROVIDERS[p].env];
    if (!keys[p]) { console.error(`Error: ${PROVIDERS[p].env} is not set (needed for --provider ${p}).`); process.exit(1); }
  }

  const prompts = args.queries
    ? (await readFile(args.queries, 'utf8')).split(/\r?\n/).map((q) => q.trim()).filter((q) => q && !q.startsWith('#'))
    : await promptsFromGsc(args.site, Math.max(1, parseInt(args['top-n'], 10) || 30));
  if (!prompts.length) { console.error('Error: no prompts to run.'); process.exit(1); }

  console.log(`AI Citation Tracker: ${args.domain}`);
  console.log(`${prompts.length} prompt(s) x ${providers.join(', ')}. Sampled measurement; see --help for what it does and does not show.\n`);

  const report = await runTracker({
    prompts, domain: args.domain, providers,
    models: { perplexity: args['perplexity-model'], openai: args['openai-model'] },
    keys, includeSubdomains: args['include-subdomains'],
    delayMs: Math.max(0, parseInt(args.delay, 10) || 0),
    timeoutMs: Math.max(1000, parseInt(args.timeout, 10) || 60000),
    onResult: (r) => console.log(`  ${{ cited: 'CITED    ', not_cited: 'not cited', error: 'ERROR    ' }[r.status]} [${r.provider}] ${r.prompt}${r.status === 'cited' ? `  -> ${r.matchedCitations[0]}` : ''}${r.error ? `  (${r.error})` : ''}`),
  });

  console.log('\n=== SUMMARY (sampled measurement) ===\n');
  for (const [p, s] of Object.entries(report.summary)) {
    console.log(`  ${p} (${s.model}): cited in ${s.cited}/${s.completed} completed answers${s.citationRate != null ? ` (${s.citationRate}%)` : ''}${s.errors ? `, ${s.errors} error(s) excluded` : ''}`);
  }
  console.log(`\n  Match rule: ${report.matchRule}. Date: ${report.generated.slice(0, 10)}.`);

  if (args.output) {
    await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport saved to ${args.output}`);
  }
  const errors = Object.values(report.summary).reduce((s, x) => s + x.errors, 0);
  process.exit(errors ? 1 : 0);
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) main().catch(fail);
