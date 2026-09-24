# 1. GEO and AEO: optimizing for answer engines, not just blue links

> **GEO** (generative engine optimization) and **AEO** (answer engine optimization) mean being the
> source that ChatGPT, Perplexity, Claude, Gemini and Google AI Overviews read, trust and cite.
> SEO gets you ranked. GEO/AEO gets you quoted.

## The shift you can see in your own Search Console

On valueaddvc.com, in the 28 days to 2026-09-21, the blog's **visible** queries split like this:

| Query shape | Impressions | CTR |
|---|---|---|
| Human-shaped ("perplexity valuation", "how much is openai worth") | 360K | **0.95%** |
| Machine-shaped (operators, quoted fragments, long research prompts, zero-click page-one queries) | 301K | **0.01%** |

A **95x CTR gap**. Nearly half of the page-one impressions come from AI research agents: they fetch
your page to answer someone else's question, and they never click. That means:

1. **Blended CTR is no longer a title metric.** A page with 93,000 impressions from one agent query
   ("tiger global aum 2026 long short") and 0 clicks does not have a title problem, and no rewrite will
   fix it. Run [`human-query-split.mjs`](../../scripts/human-query-split.mjs) before you touch a title.
2. **Those impressions are still valuable.** They are AI engines reading you. Being the page an agent
   pulls means being the source it cites. Optimize those pages for **extractability and trust**, not
   click-through.

## What makes a page citable

What we observe working, and what we built for:

- **Plain, fast, server-rendered HTML.** Agents fetch the raw document. If your key facts only appear
  after client-side JavaScript, many fetchers never see them. Blog and Pulse pages here score 100 on
  Lighthouse performance with LCP under 1s, served from the CDN edge.
- **Dated, sourced facts in the text.** "Valued at $190B (August 13, 2026, Bloomberg)" is quotable.
  "Valued at around $190B" is not. Every figure carries an as-of date and a source.
- **One page per entity.** If two of your URLs describe the same company with different numbers, an
  engine either picks one at random or trusts neither. See [Entity pages](04-entity-pages.md).
- **Honest structured data.** JSON-LD must mirror what is visible on the page. FAQ markup with no
  visible FAQ, or `dateModified` stamped "today" on every build, is exactly the kind of signal that
  gets a site's markup ignored. See [Structured data honesty](04-entity-pages.md#structured-data-honesty).
- **Labels that survive truncation.** Our title template stripped parentheses, so the valuation title
  "~$2T (target)" became "valuation: ~$2T". An IPO *target* then showed as a valuation in Google's
  results. Qualifiers like *target*, *reported* and *in talks* must never be the part a template cuts.

## Distribution channels built for machines

- **`/llms.txt`**: a plain-text map of your site for LLMs. Keep it current. Ours had drifted: it
  advertised a URL that 308-redirected to the homepage, and API endpoints that `robots.txt` blocks.
  Audit it like a sitemap: no redirects, no disallowed paths, and your most citable sections first.
- **An MCP endpoint.** Exposing read-only data over the Model Context Protocol lets AI assistants query
  you directly. Cap batch sizes and count each call in a batch against the rate limit. One JSON-RPC
  POST can otherwise carry thousands of calls.
- **Sitemaps that only list canonical, indexable URLs.** See [`sitemap-health.mjs`](../../scripts/sitemap-health.mjs).

## Provenance is the moat

AI engines are converging on the same rule humans use: cite whoever is right most often. If you use
LLM agents to research facts:

- **Never trust an agent's "verbatim" quote.** Agent web tools return model-processed text. In our
  first verification run, about half the quoted fields did not match the live page. The mismatches
  were real errors: a wrong round date, invented investors, one company's valuation attached to
  another.
- **Re-fetch and verify deterministically** with [`evidence-verifier.mjs`](../../scripts/evidence-verifier.mjs).
  Keep a fact only if its quote is on the page (verbatim or near-verbatim) and the figure is inside
  the quote. Drop the rest. A missing field costs you nothing; a wrong one costs you the citation.
- **Keep the evidence.** Store URL + quote per fact next to your data. It is your audit trail and your
  correction workflow.
- **Validate event types, not just amounts.** A regex extractor published "IPO $500B" on an entity page
  from a story about a different company's financing. 45% of regex-extracted IPO/M&A events were
  wrong. If a validator skips a whole category, that category is unvalidated.

## Checklist

- [ ] Run `human-query-split.mjs` monthly; retitle only the human opportunities it lists
- [ ] Every number on an entity page has an as-of date and a source
- [ ] No two URLs describe the same entity (merge + 301)
- [ ] JSON-LD mirrors visible content; no synthetic `dateModified`
- [ ] Title templates never strip qualifiers (target / reported / in talks)
- [ ] `/llms.txt` has no redirects and no robots-blocked paths
- [ ] Facts from LLM research pass `evidence-verifier.mjs` before publishing
