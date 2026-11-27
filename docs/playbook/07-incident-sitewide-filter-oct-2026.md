# 7. Incident: the October 2026 sitewide filter

The numbers in the rest of this playbook come from a 90-day window that ended on September 22, 2026
([RESULTS.md](../../RESULTS.md)). This chapter covers what happened after. On October 19, 2026,
valueaddvc.com lost about 94% of its Google impressions in one day, and it has not come back as of
late November. We are publishing it because a playbook that only shows the good windows is not one
you should trust.

All figures are from our own Search Console property (`sc-domain:valueaddvc.com`), with windows stated.

## What happened

| Period | Impressions per day | Clicks per day |
|---|---|---|
| Mid-September 2026 | 150K to 300K | about 400 to 1,000 |
| After the September 2026 spam update (began Sep 24, rolled out over ~13.7 days) | roughly 100K to 200K | |
| October 18, 2026 | 101,465 | |
| October 19, 2026 | 6,489 | |
| Since then | about 2,000 to 6,000 (Nov 19 to 25 average: ~2,900) | about 15 to 85 |

The September spam update cost us some traffic, but the site kept working. October was a different
kind of event: a smaller dip on October 16 to 17, then a one-day cliff on October 19.

Every part of the site fell by the same share. Pre window October 1 to 17, post window October 20 to
November 25, impressions per day:

| Page type | Before | After | Change |
|---|---|---|---|
| Blog | 72,382 | 1,757 | -98% |
| News stories | 48,697 | 368 | -99% |
| VC profiles | 6,289 | 132 | -98% |
| Tools | 4,618 | 55 | -99% |
| Homepage | 1,194 | 66 | -94% |
| A subdomain | 3,288 | 77 | -98% |

Retention was just as flat across markets and devices: the US, UK, Canada and Germany kept about 1.7%
of their impressions; India, Brazil and France about 1.0% to 1.1%. Desktop kept 1.5% and mobile 2.1%.

Two things did not change:

- **Pages stayed indexed.** Our daily index-coverage estimate (URL Inspection sampling) puts about 95% of blog URLs still indexed; a separate 30-URL spot check on Nov 8 to 14 found 27 of 30 (90%), and the 3 misses were renamed URLs that now redirect.
- **When Google did show a page, it still ranked well**, usually around positions 1 to 5. Example:
  "is anthropic profitable" went from 188 impressions a day at an average position of 3.5 to about one
  impression a month at position 2.

Of the 1,089 pages that had at least 30 impressions a day before the cliff, the median page kept 0.3%
of its impressions. About 4% kept more than 5%. The survivors were mostly deep dives on big-name
companies.

### What the results page looks like now

On November 27 we checked the 30 biggest lost queries logged out (`hl=en`, `gl=us`, `pws=0`):

- We were on page one for **0 of 30**.
- AI Overviews appeared on **30 of 30**, and still cited us on 3 of them. All three are pages
  with data few other sites carry. AI Overviews also still cited us on our control queries (brand and surviving pages), and our
  brand query still ranked #1.
- A video block appeared on 30 of 30.
- The sites on page one instead, by number of the 30 queries where they appeared: Reddit (16), Wikipedia (13), LinkedIn (10), Forbes (9),
  multiples.vc (8), Reuters, TechCrunch, Yahoo Finance and YouTube (7 each), and Sacra, TrueUp,
  Renaissance Capital, IPOScoop and X (5 each).
- Sites with the same kind of data pages as ours (multiples.vc, Sacra, TrueUp) still rank on page one. So
  "data sites" as a category do not appear to be the target.

Google did not confirm an update on October 19. Third-party trackers reported unconfirmed volatility on
October 16 and October 20 to 21. Search Console shows no manual action.

## Filter, demotion or indexing problem?

A cliff can come from three very different causes, and each needs a different response. Diagnose first.

| Signal | Sitewide filter | Demotion | Indexing problem |
|---|---|---|---|
| Impressions | Fall by about the same share everywhere | Fall, often unevenly | Fall on the pages that dropped out |
| Position when shown | Held (still 1 to 5) | Worse (page one becomes page two or three) | n/a, the page is not shown at all |
| URL Inspection | Indexed | Indexed | Not indexed, or excluded |
| Across page types, countries, devices | Uniform | Varies by page or topic | Follows the template or section that broke |

Our case fits the first column on every row: uniform low retention across six page types, seven countries
and both devices, positions held when shown, and 90 to 95% of sampled blog pages still indexed. That pattern means
Google is choosing not to show the site for most queries. It is not saying our pages are worse than the
ones it shows instead.

If the drop is concentrated in one section, country or device, it is **localized**. Look at what changed
there (a template, a redirect, a hreflang rule, a mobile rendering bug) before you assume anything sitewide.

[`filter-detector`](../../scripts/filter-detector.mjs) runs this test on Search Console exports. It reports
retention by page type, country and device, position-when-shown before and after, the per-page retention
distribution, and a verdict: SITEWIDE FILTER, DEMOTION, LOCALIZED, INDEXING PROBLEM, NO CLIFF or
INCONCLUSIVE. The thresholds are heuristics, documented in `--help`, and you can change each one.

```bash
node scripts/filter-detector.mjs --pages pages.jsonl --countries countries.csv --devices devices.csv \
  --cliff 2026-10-19 --pre-days 17 --indexed-share 0.95
```

## Causes: what we know and what we infer

**Proven** (from our own data): the timing (a dip on October 16 to 17, then the cliff on October 19), the uniform shape, held positions,
pages still indexed, no manual action, and who replaced us.

**Inferred.** Google does not tell you why a site is filtered. These are the things we did in the weeks
before that we believe contributed. We cannot prove any single one was the cause.

1. **A content burst.** About 49 new posts and about 218 rewritten posts went live between October 14 and 18.
   This is our leading explanation: it is the biggest change in the days before the cliff, and the sites
   that publish the same kind of pages at a steady pace still rank.
2. **Paid cards next to rankings.** A sponsor page offered a labelled, paid Featured card at the top of
   ranking pages, and sponsored articles. Links were marked `rel="sponsored"` and the page said rankings
   were not for sale, but a paid card above a ranked list can read as paid placement.
3. **Unqualified paid links.** Some paid and affiliate links did not carry `rel="sponsored"`.
4. **Review markup on affiliate tool pages.** Review structured data on pages that earned affiliate revenue.

## What we changed

Between October 19 and November 26:

- Every paid or affiliate link now carries `rel="sponsored"`, and a test fails the build if one does not.
- Sponsor cards now sit in their own block, separate from the ranking and never numbered.
- Review markup is gone from the affiliate tool pages.
- Automated content is capped, so a burst like October 14 to 18 cannot happen again.

One mistake after the cliff: we renamed about 45 page slugs with 308 redirects (October 31 and November 5),
hoping cleaner URLs would help. It added churn to a site that was already filtered, and it told us
nothing. We stopped.

## What we are testing now

- **Fewer, deeper pages.** The pages that survived were deep dives on companies people search for by name.
  We write fewer pages and put more into each one.
- **Pages built on data few others have.** AI Overviews still cite those pages on queries where Google's
  ten blue links no longer show us. Data no one else has is the part of the site the filter did not reach.
- **YouTube and LinkedIn.** Google shows a video block on every one of the 30 lost queries and ranks LinkedIn
  often. We publish there as surfaces Google still trusts.
- **Pre-registered predictions.** Written down on November 27, 2026, before the work, and scored on
  December 11 and December 25 from the same raw Search Console export:
  1. With no new programmatic profile pages indexed and effort moved to deep dives, blog impressions reach
     3,000 a day by December 25 (baseline 2,438 a day, the Nov 19 to 25 average). Killed if under 2,500.
  2. Visits from AI assistants (ChatGPT, Claude, Perplexity) reach 200 per 14 days (baseline 133). Killed if under 140.
  3. At least 3 of 10 YouTube Shorts titled as lost queries appear in Google's video block for that query
     within 14 days of upload. Killed if none after 21 days.
  We will add the results to this chapter and to [RESULTS.md](../../RESULTS.md), including the ones we get wrong.

## Lessons

1. **No bursts.** Publishing or rewriting hundreds of pages in a few days is a pattern search engines have every
   reason to distrust. Cap automated output per day and keep it capped.
2. **Keep paid placements visibly separate from rankings.** Disclose every paid link with `rel="sponsored"`, and enforce it with a test, not a policy doc.
3. **No slug churn.** After a hit, renaming URLs only adds noise. Fix the cause, then wait.
4. **Diagnose filter vs demotion before you act.** Rewrites can help a demoted page. On a filtered site they are
   unlikely to help, because pages that still rank 1 to 5 when shown are not losing on quality. Check retention by type, country and
   device, position when shown, and indexing, then decide what to do.
5. **Keep publishing the bad windows.** This chapter is part of the results.
