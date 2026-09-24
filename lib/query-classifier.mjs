/**
 * Human vs machine query classifier.
 *
 * In 2026 a large share of Search Console impressions come from AI research agents and
 * scrapers (ChatGPT/Perplexity/Claude browsing, AI Overviews grounding, SEO tools). Those
 * queries almost never click, so blended CTR tells you little about your titles. On
 * valueaddvc.com, visible human-shaped queries earned ~2.0% CTR while machine-shaped ones
 * earned ~0.3%. A page with 90K impressions and 0 clicks from one agent query is NOT a
 * title problem.
 *
 * Two layers:
 *   1. isHumanQuery(q): textual shape (operators, quoting, domains, ids, instruction
 *      phrasing, very long queries, day-level dates).
 *   2. isZeroClickAgent(stats): behavioural. A query shown 300+ times on page one
 *      (pos <= 8) with zero clicks is an agent even when it reads human
 *      ("tiger global aum 2026 long short": 93K impressions, 0 clicks).
 *
 * Conservative by design: when in doubt a query counts as machine, so human metrics are
 * computed on queries you can actually win.
 */

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

export function isHumanQuery(query) {
  const s = String(query || "").toLowerCase().trim();
  if (!s) return false;
  const words = s.split(/\s+/);
  if (/["+%|]|site:|intitle:|inurl:|filetype:/.test(s)) return false; // search operators / quoting
  if (words.length >= 8) return false; // agent research prompts are long
  if (/^(evaluate|compare the|which leading|i'm a|i am a|find |list |provide |summarize|explain the)/.test(s)) return false;
  if (new RegExp(`\\b(${MONTHS}) \\d{1,2}\\b`).test(s)) return false; // day-level dates ("june 26")
  if (new RegExp(`\\b(${MONTHS}) 20\\d\\d\\b`).test(s) && words.length >= 6) return false; // long month+year
  if (/\b20\d\d\s*-\s*20\d\d\b/.test(s)) return false; // "2022-2026"
  if (/\b[a-z0-9-]+\.(com|ai|io|co|net|org|app|dev|xyz)\b/.test(s)) return false; // domains
  if (/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{5,}\b/.test(s) && !/\b(gpt|o\d|h\d|b\d|a\d)/.test(s)) return false; // ids like "ai87714"
  if (/how much money has|recent deals announced/.test(s)) return false; // templated agent phrasing
  return true;
}

/** stats: { impressions, clicks, position } aggregated for one query over the window. */
export function isZeroClickAgent({ impressions = 0, clicks = 0, position = 99 } = {}, { minImpressions = 300, maxPosition = 8 } = {}) {
  return impressions >= minImpressions && clicks === 0 && position <= maxPosition;
}

/** Split aggregated query rows ({query, impressions, clicks, position}) into human and machine buckets. */
export function splitQueries(rows, opts) {
  const human = [], machine = [];
  for (const r of rows) (isHumanQuery(r.query) && !isZeroClickAgent(r, opts) ? human : machine).push(r);
  return { human, machine };
}
