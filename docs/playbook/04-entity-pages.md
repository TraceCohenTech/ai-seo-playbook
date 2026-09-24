# 4. Entity pages: one page per thing, one number per fact

Programmatic entity pages (companies, investors, products, places) are where AI engines and long-tail
search meet. They're also where sites quietly contradict themselves.

## One page per entity

We had two page types per company: a hand-written profile and an auto-generated data hub. Both were
self-canonical, both ranked around position 7–8 for "<company> valuation", and they **stated different
valuations** (e.g. $25B on one, $48B on the other). Google split the ranking between them; an answer
engine sees a source that disagrees with itself.

The fix:
1. Pick the page type that scales and stays current (the data hub) as the single canonical URL.
2. Move the hand-written editorial sections onto it (business model, competitors, related links, FAQs).
3. **Take numbers only from one sourced store.** Drop the hand-typed valuation and funding text: it goes
   stale, and two numbers on one page is the reason you're merging.
4. 301 each old URL with an **explicit map**, not a wildcard (slugs differ: `perplexity-ai` → `perplexity`).
   Check that no existing redirect points *into* the old paths, which would create chains.
5. Before redirecting, verify **every destination returns 200 and is indexable**. Three of our 24 targets
   were `noindex` at the time; redirecting into them would have thrown their rankings away.
6. Update internal links and sitemaps so nothing routes through a redirect.

## Index on substance, not story count

Our hub rule was "index if the company has ≥3 news stories". That ignored hubs with a real data profile
and 2 stories (142 were noindexed), while indexing 1-story hubs that no sitemap listed. The rule
rewarded having *fewer* stories. One shared function now decides both the robots tag and the sitemap
entry:

```js
indexable = hasCuratedProfile || stories >= 3 || (tier !== "sparse" && metrics > 0)
```

Company hubs in the sitemap went from 253 to 411, each checked as 200, indexable and self-canonical.

## Sitemaps only list what you want indexed

- Only 200, indexable, self-canonical URLs. No redirects, no `noindex`, no duplicates.
- Apply the **same eligibility rule** in every sitemap. Our news sitemap skipped the duplicate filter
  the main Pulse sitemap used, and the one story whose canonical pointed elsewhere was the entire
  Search Console "errors=1" we'd been chasing.
- `lastmod` only when it's real. No date is better than a fake one.

## Structured data honesty

- **FAQPage markup needs a visible FAQ.** We had merged FAQs into the JSON-LD with no rendered FAQ on
  24 high-value pages. Render them (a `<details>` list works) or drop the schema.
- **`dateModified` must be a real date.** A helper defaulted it to "today", so 25 data pages claimed a
  fresh update on every build (Q2 data "modified" in late September).
- **Titles and descriptions must keep qualifiers** (*target*, *reported*, *in talks*). Our title
  template removed anything in parentheses, so "~$2T (target)" was published as a valuation.

## Data rules that keep entity pages true

What our data audit found in automatically extracted facts, and the deterministic rule that now
blocks each:

| Error class | Example | Rule |
|---|---|---|
| Sector totals stored as one company's round | "$19.5B round" (a sector tally, 28× the real round) | Reject self-sourced/analysis stories and tally/YTD/combined figures |
| Figure about a different subject | a "$42B round" taken from a global funding roundup | The story must be *about* the entity (its slug/headline names it) |
| Non-raise stored as a raise | a $6B license deal shown as a funding round | License / revenue / stake / net-worth nouns are not raises |
| Unit-less numbers | a price like "$72,384" parsed as a round | No unit (K/M/B), no round |
| Borrowed fields in dedupe | one company's valuation filled in from another record | Merge or fill only the same deal (same type, amounts within 25%) and record where each filled field came from |
| Filing or plan stored as done | "S-1 filed" shown as a completed IPO | Filings, plans and "in talks" are not events |
| Name collisions with official filings | a Florida LLC's SEC filing attached to a famous namesake | Identity gate: known-bad IDs excluded with reasons, and entity-type and domain checks |
