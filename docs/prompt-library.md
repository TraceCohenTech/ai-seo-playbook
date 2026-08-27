# Prompt Library

Production-tested prompts for the AI content engine. These aren't generic templates — they encode the specific rules and thresholds from the playbook into copy-paste prompts you can run with Claude, ChatGPT, or any LLM.

---

## Title Rewrite Engine

```
You are an elite SEO title engineer. I'll give you a list of page titles
with their current CTR and average position from Google Search Console.

For each title, rewrite it following these rules:
1. Start with the most specific, surprising number from the content
2. Use dollar amounts ($347B), percentages (42%), multipliers (302,667x),
   or counts (14 tools)
3. Keep total length under 60 characters
4. The number should create curiosity or signal authority
5. Never use generic words like "guide", "ultimate", "complete"
6. Add a dash separator between the number hook and the topic

Output format:
| Original Title | New Title | Character Count | Hook Type ($/% /x/count) |
```

Run on a 2-week cadence. Each cycle, focus on the top 15–20 underperformers (position 4–20, 1,000+ impressions, CTR <2%). Use `rewrite-measurer.mjs` to track before/after.

---

## Schema Generator

```
You are a structured data engineer. Generate JSON-LD schema for the following page.

Page URL: [URL]
Page title: [TITLE]
Page type: [blog post / dashboard / tool / category page]
Key stats mentioned: [LIST 3-5 NUMBERS FROM THE CONTENT]
Author name: [NAME]
Author social profiles: [TWITTER, LINKEDIN URLs]

Generate ALL applicable schemas from this list:
1. FAQPage (3-5 Q&As, answers start with numbers, 50-90 words each)
2. Dataset (if data/tool page — include temporalCoverage and variableMeasured)
3. Article (if blog post — include author entity with sameAs)
4. BreadcrumbList (always)
5. Organization (if root layout)

Output as a single script tag with an array of schemas. Validate each against
Google's Rich Results Test requirements.
```

See `config/schema-rules.json` for the full 7-type deployment map.

---

## AEO Content Optimizer

```
You are an AI Engine Optimization specialist. Analyze this content and optimize it
to maximize the probability of being cited by Perplexity, ChatGPT, and Claude.

Apply these transformations:
1. ADD a 2-3 sentence "quick answer" block at the very top with the core finding + key number
2. INCREASE factual density — add specific numbers, dates, $ amounts, or percentages
   to every paragraph that currently lacks them
3. RESTRUCTURE for extractability — break into clear H2/H3 sections where each
   section answers one specific question
4. ADD entity clarity — name the who/what behind every claim
5. CONVERT opinions to data-backed statements wherever possible
6. ADD a "Key Takeaways" bullet list (3-5 items, each starting with a number)

Output the optimized content with [CHANGED] markers on every modified paragraph.
Also output a "Factual Density Score" — count of specific numbers per 500 words,
before and after.
```

Use `factual-density-scorer.mjs` to validate the before/after scores programmatically.

---

## Content Audit Scorer

```
You are a content auditor. Score each page below against these 8 dimensions
(1 = fail, 2 = marginal, 3 = pass):

1. Word Count (800+ = 3, 400-799 = 2, <400 = 1)
2. Data Density (3+ stats/1K words = 3, 1-2 = 2, 0 = 1)
3. Internal Links Out (2+ = 3, 1 = 2, 0 = 1)
4. External Links (2+ = 3, 1 = 2, 0 = 1)
5. Schema Markup (FAQPage+Article = 3, Article only = 2, none = 1)
6. Keyword Targeting (title matches query = 3, partial = 2, none = 1)
7. Freshness (updated <3mo = 3, 3-6mo = 2, >6mo = 1)
8. Cannibalization (unique target = 3, partial overlap = 2, direct duplicate = 1)

For each page output:
| URL | Total Score /24 | Action (Keep/Update/Merge/Kill) | Priority | Specific Fix |

Sort by score ascending (worst first). Group merge candidates together.
```

---

## Internal Link Injector

```
You are an internal linking specialist. I'll give you a blog post and a list of all
pages on my site with their URLs and topics.

Find every natural opportunity to add a contextual internal link. Rules:
1. Only link where the topic is NATURALLY mentioned — never force a link
2. Use descriptive anchor text (not "click here" or "read more")
3. Max 1 link per destination page per post
4. Max 5-8 total internal links per post
5. Prioritize linking to high-value pages (tools, dashboards, pillar content)
6. Never link the same anchor text to different destinations
7. Place links at first mention of each topic

Output the modified content with all new links in markdown format.
Also output a summary: | Anchor Text | Destination URL | Paragraph # |
```

---

## Meta Description Batch Writer

```
Write SEO meta descriptions for these pages. Rules:
- Start with the most surprising number or stat from the page
- 150-155 characters max (Google truncates at 155)
- Include a clear value proposition (what the reader gets)
- End with implicit CTA ("see the data", "explore", "compare")
- Never use: ultimate, comprehensive, definitive, guide
```

---

## FAQ Schema from Content

```
Read this content and generate FAQPage JSON-LD schema. Rules:
- Extract 3-5 questions that real users would search for on Google
- Validate questions against Google autocomplete
- Every answer MUST start with a specific number
- Answers: 50-90 words each, at least 1 data point per answer
- Output valid JSON-LD ready to paste into a script tag
```

---

## Full Post Optimization (SEO + AEO + Schema)

The all-in-one prompt for maximum impact on a single page:

```
Optimize this blog post for both Google SEO and AI Engine Optimization. Apply ALL:

SEO Layer:
1. Rewrite title: numbers-first, under 60 chars
2. Rewrite meta description: stat-first, 150-155 chars
3. Add H2/H3 structure if missing (one question per section)
4. Ensure 800+ word count — expand thin sections with data
5. Add 3-5 internal link opportunities (mark with [LINK: /suggested-url])

AEO Layer:
6. Add quick-answer block at top (2-3 sentences, lead with number)
7. Increase factual density to 3+ stats per 500 words
8. Add "Key Takeaways" section (3-5 bullets, each starts with a number)
9. Ensure every claim is attributable to a named source

Schema Layer:
10. Generate FAQPage JSON-LD (3-5 Qs)
11. Generate Article JSON-LD with author entity
12. Generate BreadcrumbList JSON-LD

Output full optimized post + all 3 schema blocks.
Score before/after: word count, data density, internal links, schema coverage.
```

---

## Competitive Content Gap Analysis

```
I run a site about [TOPIC]. Here are my top 20 pages by traffic:
[PASTE URL + TITLE LIST]

And here are the top 20 pages from my competitor:
[PASTE COMPETITOR URL + TITLE LIST]

Find:
1. GAPS — Topics my competitor covers that I don't
2. OVERLAPS — Topics we both cover where I can improve
3. ANGLE GAPS — Topics I cover from a weaker angle
4. OPPORTUNITY SCORE — Rate each gap 1-10 (search volume + ease)

Output a prioritized content calendar:
| Week | Topic | Type (new/update) | Target Keyword | Angle | Opportunity Score |
```

---

## Cannibalization Fix Plan

```
These pages on my site are cannibalizing each other:
[PASTE: pairs/groups of URLs with target keywords and GSC metrics]

For each cannibalization group:
1. Pick the WINNER (highest authority, best content, strongest URL)
2. Define what happens to the LOSER(s): merge content or 301 redirect
3. If merging: specify which sections to incorporate
4. Write the 301 redirect rule
5. List all internal links that need updating

Output a step-by-step execution plan.
```

Use `cannibalization-detector.mjs` to find the clusters first.

---

## GSC Performance Analyzer

```
You are a search performance analyst. I'll give you a GSC data export with columns:
Page, Clicks, Impressions, CTR, Position.

Analyze and produce:
1. TOP OPPORTUNITIES — Pages with high impressions but CTR <2% (title rewrite candidates)
2. QUICK WINS — Pages at position 4-10 that could reach top 3 with content updates
3. CANNIBALIZATION — Multiple pages ranking for same or similar queries
4. DECLINING PAGES — Pages where position worsened >3 spots vs prior period
5. ZERO-CLICK PAGES — Pages with impressions but 0 clicks

For each finding:
| Page URL | Issue | Current Metrics | Recommended Action | Expected Impact |

Sort by expected impact. Flag the top 5 actions for this week.
```

---

## Redirect Planner

```
You are a URL hygiene specialist. I'll give you a list of URLs with their
word counts, last update dates, and monthly impressions from GSC.

Analyze and produce a redirect plan:
1. IDENTIFY pages to kill (thin <400 words, stale >6 months, <50 impressions)
2. IDENTIFY merge candidates (2+ pages targeting the same keyword)
3. IDENTIFY de-versioning opportunities (URLs containing version numbers)
4. For each redirect, specify the BEST destination URL (not homepage)
5. Flag any redirect chains that would result

Output: | Source URL | Action | Destination URL | Reason | Impressions Lost |
Sort by impressions descending.

Cardinal rule: never delete without a 301 redirect. Never redirect to homepage.
```
