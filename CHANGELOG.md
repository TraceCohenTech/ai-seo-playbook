# Changelog

## 2.0.0 (2026-09-24): SEO + GEO/AEO edition

**New playbook** ([docs/playbook](docs/playbook)), six chapters from running the engine on a site that reached
11.08M impressions / 44.8K clicks in 90 days ([RESULTS.md](RESULTS.md)):
GEO/AEO, measurement, incidents and guardrails, entity pages, the content refresh system, and automation and cost.

**New tools**
- `human-query-split.mjs`: separates human from AI-agent impressions and finds the real retitle opportunities
- `matched-control-readout.mjs`: measures a change against untouched pages (replaces `rewrite-measurer`)
- `traffic-guard.mjs`: daily drop alarm with three baselines; exit code 2 on alert; optional webhook
- `sitemap-health.mjs`: sampled, paced sitemap QA (status, robots, canonical, duplicates)
- `evidence-verifier.mjs`: re-fetches sources and checks each fact's quote is really on the page
- `rewrite-detector.mjs`: finds news stories that re-report the same event
- `lib/`: shared CLI (`--help` on every script, proper exit codes), GSC paging, query classifier, rewrite rules

**Fixed** (see the audit in the PR description)
- `thin-content-detector` and `content-audit` no longer wipe Next.js JSX and recommend NOINDEX/KILL on normal pages
- `meta-length-checker` parses and handles apostrophes and CRLF
- `ai-citation-tracker` uses official APIs instead of scraping, which always reported 0%
- `indexing-submitter` is restricted to Google's allowed use (JobPosting / BroadcastEvent)
- plus the GSC-script logic fixes, redirect/link/schema checker fixes, and every script's `--help`

**Corrected guidance**
- The Indexing API is not a general "instant crawl" tool
- Google retired the sitemap ping in 2023; WebSub is for feeds
- FAQ rich results have been limited to authoritative gov/health sites since Aug 2023, so FAQ markup is optional
- The sitelinks search box was removed in Nov 2024
- Crawl budget matters mainly for very large sites
- Removed advice to jitter publish timestamps so automation "looks organic"
- Unsourced benchmark claims are labelled as heuristics or removed; examples use fictional companies
- Prompts may only add numbers from supplied sources

**Infra:** CI runs syntax checks and offline tests on Node 20/22/24. The weekly report workflow moved to
`examples/workflows/` as a template, since it failed in this repo without configuration.

## 1.x (2026-08-15 → 2026-08-27)
The initial scripts, configs, prompt library and the valueaddvc.com case study.
