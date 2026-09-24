# Results

The single source of truth for every number this repo quotes. Every figure comes from the Google
Search Console API for [valueaddvc.com](https://valueaddvc.com) (property `sc-domain:valueaddvc.com`),
has a stated window, and was pulled on **2026-09-24**. If a number elsewhere in this repo disagrees with
this file, this file wins.

## Search performance

| Window | Impressions | Clicks |
|---|---|---|
| Last 90 days (2026-06-25 → 2026-09-22) | **11.08M** | **44.8K** |
| Previous 90 days (2026-03-27 → 2026-06-24)* | 1.44M | 3.7K |
| Growth, 90d over 90d | **7.7×** | **12.2×** |
| Last 30 days (2026-08-24 → 2026-09-22) | **6.43M** | **24.9K** |

\*The previous window has 62 days of data because the property's data starts on 2026-04-24.

| Month | Impressions | Clicks |
|---|---|---|
| June 2026 | 1.12M | 3.2K |
| August 2026 | 3.46M | 17.1K |
| September 1–22, 2026 | 5.36M | 19.3K |

- **Peak day:** 1,232 clicks (2026-09-08); 367K impressions (2026-09-09)
- **Pages with at least one impression (90d):** 9,827; with at least one click: 3,458
- **Queries ranking in the top 3 (last 30d):** 5,063

## Human vs machine queries

Blog pages, visible queries only, 28 days to 2026-09-21
([`human-query-split.mjs`](scripts/human-query-split.mjs)):

| Query shape | Impressions | CTR |
|---|---|---|
| Human-shaped | 360K | 0.95% |
| Machine-shaped (AI agents, scrapers, SEO tools) | 301K | 0.01% |

## Measured changes

Matched control: untouched pages with ≥300 impressions in the *before* window, same windows
([`matched-control-readout.mjs`](scripts/matched-control-readout.mjs)). Ranges reflect different window
centers and whether the days around the change are excluded (the tool's default excludes ±3 days).
The effect is robust in sign; its size is ~19–48 points of lift over the control. See [Measurement](docs/playbook/02-measurement.md) for method and caveats.

| Change | n | Treated | Control |
|---|---|---|---|
| Title rewrites, Aug 19–21, 2026 | 35 | +27% to +53% clicks | −2% to +8% |
| Snippet rewrites, Sep 3, 2026 | 68 | +2% | +14% |
| Freshness refreshes, Sep 2026 | 10 | −38% | +14% (selection bias: pages picked at their news peak) |

## The incident

A site-wide `X-Robots-Tag: noindex` was live for ~28 hours (2026-09-16 → 2026-09-17). Daily
impressions fell ~55% at the low point. Clicks recovered to pre-incident levels within about a
week (~1,100/day on 2026-09-21/22 vs ~940/day in the week of 2026-09-07). See
[Incidents and guardrails](docs/playbook/03-incidents-and-guardrails.md).

## Reproduce

```bash
node scripts/weekly-report.mjs --site sc-domain:yoursite.com
node scripts/human-query-split.mjs --site sc-domain:yoursite.com
node scripts/matched-control-readout.mjs --site sc-domain:yoursite.com --changes changes.json
```
