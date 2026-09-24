# 5. The content refresh system: change fewer pages, and only the right ones

We paused our daily "refresh top posts" and weekly "retitle" automations and measured them first
(see [Measurement](02-measurement.md)). They were spending most of their effort on the wrong pages:
- the retitle queue ("position ≤10, CTR <1%") was dominated by AI-agent impressions, and
- the refresh pool was "top 20 by clicks": our winners, including news spikes already fading.

We rebuilt it as a weekly, deterministic queue that the AI routines consume.

## The queue (built weekly from Search Console, no LLM calls)

1. **Human queries only.** Score pages on human-shaped queries ([`lib/query-classifier.mjs`](../../lib/query-classifier.mjs)).
2. **Retitle pool**: pages at human position ≤8 whose human CTR is below 50% of **your own site's median
   human CTR at that position**. Your own curve, not an industry benchmark.
3. **Refresh pool**: page-2 posts (human position 8–20) with real human demand, plus winners whose facts
   are 60+ days old (facts only, never the title or URL).
4. **Protect winners**: pages with strong clicks and CTR are never retitled.
5. **Cooldown**: nothing is touched again within 45 days.
6. **Skip fading pages**: recent 14-day impressions under half of the prior 14 days means a news spike
   is decaying. Leave it.
7. **Holdout**: a stable hash of ~20% of eligible pages is never touched, as the control.
8. **Start date**: the queue carries a `notBefore` date, so routines idle until a clean baseline exists
   (we waited out a week after an incident).

## Rules for the AI step

- A new title must keep the page's #1 human query's key terms. That's what it ranks for.
- Lead with the page's strongest specific fact **from the page itself**; invent nothing.
- ≤70 characters for titles; 70–160 for descriptions, with a number in the first 6 words.
- A snippet edit is not a freshness update: don't bump `dateModified` for it.
- Refresh = verify every dated figure against current sources and add inline citations. If nothing
  changed, **don't edit the file**. Faked freshness is worse than none.
- Gate every edit: typecheck, content quality gate, and revert on failure.

## Cost

About 17 page edits a week instead of about 40, with every one measured. The queue itself is
free: one Search Console pull and a few seconds of JavaScript.
