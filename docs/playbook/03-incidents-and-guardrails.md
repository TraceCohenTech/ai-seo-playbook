# 3. Incidents and guardrails: the day we noindexed our own site

## What happened

A routine change broadened a Next.js middleware `matcher` so that it ran on every request, to support a
subdomain rewrite. Deep in that middleware, an admin-only branch set
`X-Robots-Tag: noindex, nofollow, noarchive`. It had only ever been scoped by the matcher, never by
an explicit path check. For **28 hours** every public page told Google not to index it.

The same day, crawler fan-out on thousands of newly-rendered entity pages rate-limited the site's
self-fetches of its own data (HTTP 429). A retry with no backoff threw inside `generateMetadata`, and
Googlebot got **500s** on entity pages.

Daily impressions fell about 55% within days. The 28-day rolling reports barely moved. Clicks fully
recovered within about a week of the fix. Impressions recovered more slowly, and most of what stayed
lost was machine-query volume that never clicked.

## Guardrails we built (all deterministic, zero LLM calls)

| Guardrail | Catches | How |
|---|---|---|
| Header check on key public URLs (CI, every deploy + periodic) | a stray `X-Robots-Tag: noindex` | Assert its absence on `/`, main hubs and a sample of pages |
| 5xx probe on entity templates | render-time errors served to crawlers | Hit a sample of dynamic routes every few hours |
| [`traffic-guard.mjs`](../../scripts/traffic-guard.mjs), daily | traffic cliffs and slow recoveries | 3 baselines: weekday, 7-day, and a clicks-only 4–5-week baseline |
| Protected-file pre-push gate | risky edits to SEO-critical files | Pushes touching middleware, the Next config, robots, sitemaps or the root layout need an explicit reviewed tag in the commit message |
| Deploy verification | "merged" ≠ "live" | Poll a `/version.json` for the merge SHA, then test live pages |
| Heartbeat for scheduled jobs | a dead server or stuck cron | Alert if no automation commit lands for N hours |

## Rules we now follow

1. **Scope every header or robots rule with an explicit path check**, never only through a matcher or
   route group that someone may broaden later.
2. **Retry with backoff, and fall back gracefully in metadata.** A metadata function that throws turns a
   rate limit into a 500 for Googlebot.
3. **Alert on daily data.** Rolling windows are for trends, not incidents.
4. **Verify what a URL actually serves**: title, canonical, robots meta, `X-Robots-Tag`. Not just the
   status code. A "live" subdomain once returned 200 while serving the main site's homepage.
5. **Watch the deploy, not the merge.** Our build filter skipped deploys for changes under `scripts/`,
   but that folder held the build-time data generators. A data-quality fix merged, showed green, and
   never went live. Test that your "skip build" rules can't swallow code that runs during the build.
6. **Previews aren't production.** Behind deployment protection, pages that fetch their own data got
   302'd to a login and returned 500 on the preview. So we verify entity-page changes on production
   immediately after deploy, with a rollback ready.
7. **Audits must not become incidents.** Crawling your own site hard can trip your host's bot
   protection. Sample and pace ([`sitemap-health.mjs`](../../scripts/sitemap-health.mjs)).
8. **Alerts must reach a human.** Our cron alerts used macOS notification commands, which silently did
   nothing on the Linux server they had moved to. Test the alert path end to end.
