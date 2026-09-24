# 2. Measurement: know whether a change worked

Most SEO "wins" are sites growing, seasons turning, or pages regressing to the mean. Here is how we
measure, and the mistakes that nearly fooled us.

## Always compare against a matched control

A cohort of changed pages means nothing on its own. Compare it with pages that:
- existed in the *before* window with real impressions (e.g. ≥300), and
- you did **not** touch,

measured over the same two windows. [`matched-control-readout.mjs`](../../scripts/matched-control-readout.mjs) does this.

What it showed on valueaddvc.com (blog, ±21 days around each change):

| Change | Treated | Matched control | Verdict |
|---|---|---|---|
| Title rewrites on high-impression, low-CTR pages (35 pages) | **+27% to +36% clicks** | −2% to +8% | Worked: roughly 20–38 points of lift, depending on the window |
| Snippet rewrites, title + description + quick answer (68 pages) | +2% | +14% | Not worth the tokens |
| "Freshness" refreshes of top-clicked posts (10 pages) | −38% | +14% | Misleading: the pages were chosen at their news peak and regressed |

## Traps that fooled us

1. **Unmatched controls.** Our first control group kept adding newly published posts, which inflated its
   growth to +110% and made every treatment look like a loss. Match on existence and minimum
   impressions in the *before* window.
2. **URL variants overwrite each other.** GSC reports `/post` and `/post/` (and typo'd inbound links)
   as separate rows. Normalize, then **sum**. A map that overwrote instead of adding let a 0-click
   trailing-slash variant erase a 518-click page and flipped a +36% result to −39%.
3. **Window sensitivity.** Shifting the window by 4 days moved one result from +44% to +27%. Always
   report a range across two or three window centers, never a single headline number.
4. **Selection bias.** "Refresh the top 20 posts by clicks" picks pages at their peak. News-driven posts
   decay whatever you do. Exclude fading pages (recent 14-day impressions < 50% of the prior 14) before
   choosing what to refresh.
5. **Rolling windows hide cliffs.** A 28-day rolling report turned a 55% overnight drop into a gentle
   slope. Watch daily data ([`traffic-guard.mjs`](../../scripts/traffic-guard.mjs)).
6. **Provisional days.** GSC's newest two or three days are incomplete. Judge "yesterday" three days late.
7. **Blended CTR.** See [GEO/AEO](01-geo-aeo.md). Measure CTR on human-shaped queries, or AI-agent
   impressions will bury every signal.

## Build measurement into the system, not the retro

- Keep a **holdout**: a stable, hash-based ~20% of eligible pages you never touch. It is your
  always-on control group.
- **Log every change** with its date and the page's baseline (human impressions, clicks, position).
- Run a **21-day readout** weekly and flag any change that fell 30+ points behind the holdout for a
  human to review. Don't auto-revert.
- Enforce a **cooldown** (we use 45 days) so a page isn't changed again before its last change can be
  measured.

## Honest reporting

- Report **clicks** as the headline; impressions are increasingly machine-driven.
- Put dates and windows on every number.
- When a result depends on the window, say so. A playbook that overclaims loses the trust that makes
  it worth reading.
