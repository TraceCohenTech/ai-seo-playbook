# The AI SEO Playbook: SEO + GEO + AEO

[![CI](https://github.com/TraceCohenTech/ai-seo-playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/TraceCohenTech/ai-seo-playbook/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)

**The open-source operating system behind a content site that reached 11.08M impressions and 44.8K clicks in
90 days.** That's 7.7× the impressions and 12× the clicks of the previous 90 days. Every number here is verifiable in
[RESULTS.md](RESULTS.md).

This isn't a list of tips. It's the methodology, the scripts, and the guardrails we actually run: tested, measured
against controls, and including the mistakes that cost us traffic so you don't repeat them.

## The 2026 reality most SEO advice misses

On our blog, human-shaped search queries convert at **0.95%**. Machine-shaped ones (AI research agents,
scrapers, SEO tools) convert at **0.01%**, a **95× gap**, and they make up almost half of the page-one
impressions. So:

- **Your blended CTR is no longer a title metric.** Retitling a page whose impressions come from an AI agent does nothing.
  [`human-query-split`](scripts/human-query-split.mjs) shows you which pages are really underperforming *for humans*.
- **Those agent impressions still matter.** They are AI engines reading you. Winning **GEO/AEO** (being the source
  ChatGPT, Perplexity, Claude and Google AI Overviews cite) takes extractable, dated, *verified* facts.
  [Chapter 1](docs/playbook/01-geo-aeo.md) covers how.
- **Most "wins" aren't.** Measured against untouched pages, our title rewrites outgrew the control by roughly 19–48 points (depending on the window).
  Our snippet rewrites did nothing, and our "freshness refreshes" only looked like losses because they picked
  fading news. [Chapter 2](docs/playbook/02-measurement.md) shows how to tell the difference.

## Who this is for

Founders, marketers and engineers running content, programmatic or news sites, especially with AI in the
content pipeline, who want rankings **and** AI citations without gambling on unmeasured tactics.

## Quick start

```bash
git clone https://github.com/TraceCohenTech/ai-seo-playbook && cd ai-seo-playbook
npm ci
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
```

```bash
# Is your low CTR a title problem or an AI-agent problem?
node scripts/human-query-split.mjs --site sc-domain:yoursite.com

# Daily drop alarm for cron/CI (exit code 2 = alert)
node scripts/traffic-guard.mjs --site sc-domain:yoursite.com --webhook https://ntfy.sh/your-topic

# Are the URLs in your sitemaps actually indexable?
node scripts/sitemap-health.mjs --sitemap https://yoursite.com/sitemap.xml
```

Every script prints its full documentation with `--help`. Setup details are in [docs/setup-gsc.md](docs/setup-gsc.md).

## The playbook

| # | Chapter | You'll learn |
|---|---|---|
| 1 | [GEO and AEO](docs/playbook/01-geo-aeo.md) | Being cited by answer engines: extractable facts, provenance, llms.txt, MCP |
| 2 | [Measurement](docs/playbook/02-measurement.md) | Matched controls, holdouts, and the traps that fake your wins |
| 3 | [Incidents and guardrails](docs/playbook/03-incidents-and-guardrails.md) | The day we noindexed our own site, and the guards that now catch it |
| 4 | [Entity pages](docs/playbook/04-entity-pages.md) | One page per entity, indexing on substance, honest structured data |
| 5 | [The content refresh system](docs/playbook/05-content-refresh-system.md) | Change fewer pages, and only the right ones |
| 6 | [Automation and cost](docs/playbook/06-automation-and-cost.md) | Running cron + AI routines + CI safely and cheaply |

Plus a [prompt library](docs/prompt-library.md) with sourcing rules built in, and a [bot-traffic guide](docs/bot-traffic.md).

## The toolkit

### Understand your traffic (Search Console)
| Script | What it tells you |
|---|---|
| [`human-query-split`](scripts/human-query-split.mjs) | Human vs AI-agent impressions per page; the real retitle list |
| [`weekly-report`](scripts/weekly-report.mjs) | Week-over-week movers, trending queries, CTR triage |
| [`striking-distance`](scripts/striking-distance.mjs) | Pages at position 5–20 where a push pays off most |
| [`ctr-audit`](scripts/ctr-audit.mjs) | The click gap against a CTR curve fitted to *your* site |
| [`gsc-rewrite-candidates`](scripts/gsc-rewrite-candidates.mjs) | Title rewrite candidates (optionally human queries only) |
| [`cannibalization-detector`](scripts/cannibalization-detector.mjs) | Queries where your own pages compete; flagged for review |
| [`query-gap-miner`](scripts/query-gap-miner.mjs) | Queries you rank for without a page that targets them |
| [`refresh-tracker`](scripts/refresh-tracker.mjs) | Aging pages that are losing traffic |

### Measure changes honestly
| Script | What it tells you |
|---|---|
| [`matched-control-readout`](scripts/matched-control-readout.mjs) | Did the change work, compared with pages you didn't touch? |
| [`rewrite-measurer`](scripts/rewrite-measurer.mjs) | One change date vs a control band of similar-traffic pages; skips the change week and waits for complete data |

### Protect what you've built
| Script | What it catches |
|---|---|
| [`traffic-guard`](scripts/traffic-guard.mjs) | Daily traffic cliffs and slow recoveries (3 baselines) |
| [`sitemap-health`](scripts/sitemap-health.mjs) | Sitemap URLs that redirect, 404, are noindexed or canonicalize elsewhere |
| [`redirect-checker`](scripts/redirect-checker.mjs) | Redirect chains and sitemap URLs that redirect |
| [`broken-link-checker`](scripts/broken-link-checker.mjs) | Broken internal and external links |
| [`schema-validator`](scripts/schema-validator.mjs) | Invalid or incomplete JSON-LD (including Next.js and `@graph`) |
| [`meta-length-checker`](scripts/meta-length-checker.mjs) | Titles and descriptions that will be truncated |

### GEO / AEO and data quality
| Script | What it does |
|---|---|
| [`evidence-verifier`](scripts/evidence-verifier.mjs) | Checks every fact's quote is really on its source page before you publish |
| [`ai-citation-tracker`](scripts/ai-citation-tracker.mjs) | Samples which domains AI engines cite for your queries (official APIs only) |
| [`factual-density-scorer`](scripts/factual-density-scorer.mjs) | How much specific, extractable fact a page carries |
| [`rewrite-detector`](scripts/rewrite-detector.mjs) | News stories re-reporting the same event under a new URL |

### Content quality
| Script | What it finds |
|---|---|
| [`content-audit`](scripts/content-audit.mjs) | Every page scored by traffic and quality, with review labels |
| [`thin-content-detector`](scripts/thin-content-detector.mjs) | Thin pages, with age and traffic guards before any noindex suggestion |
| [`template-detector`](scripts/template-detector.mjs) | AI template phrases (lists in [config/anti-ai-rules.json](config/anti-ai-rules.json)) |
| [`orphan-finder`](scripts/orphan-finder.mjs) | Pages nothing links to |

### Feeds and indexing
| Script | Use it for |
|---|---|
| [`websub-ping`](scripts/websub-ping.mjs) | Notifying a WebSub hub when an RSS/Atom feed that declares it changes |
| [`indexing-submitter`](scripts/indexing-submitter.mjs) | **Job posting and livestream pages only**, as Google's policy requires |

To run the weekly report on a schedule, copy [`examples/workflows/weekly-seo-report.yml`](examples/workflows/weekly-seo-report.yml) into your site's repo.

Configs (quality gates, title rules, refresh rules, schema rules…) live in [`config/`](config), and JSON-LD templates in
[`schemas/`](schemas). Sample outputs for the scripts are in [`samples/`](samples), generated from test fixtures.

## Principles

1. **Measure against a control, or it didn't happen.**
2. **Separate humans from machines** before judging CTR.
3. **Every fact needs a source you can re-check.** AI answer engines reward being right.
4. **Structured data mirrors visible content.** No synthetic dates or invisible FAQs.
5. **Guardrails before automation.** If a machine can publish it, a machine should also be able to catch it.
6. **No tricks that need hiding.** Nothing here disguises automation or games a policy.

## Results

Full numbers, windows and methods are in [RESULTS.md](RESULTS.md). The site behind them is [valueaddvc.com](https://valueaddvc.com),
a startup and venture-capital intelligence platform with ~1,100 articles, a daily news feed and thousands of
programmatic company and investor pages.

## Roadmap and community

The playbook and scripts are and stay free (MIT). See [ROADMAP.md](ROADMAP.md) for what's next, including hosted audits.
Contributions with real numbers and windows are very welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

Built by [Trace Cohen](https://valueaddvc.com/tracecohen) at [Value Add VC](https://valueaddvc.com). If this helped you, a ⭐ helps others find it.

## License

MIT, see [LICENSE](LICENSE).
