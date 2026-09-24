# Identifying and Accounting for Bot Traffic

Your analytics numbers are lying to you. Here's how to figure out by how much.

## The Problem

In our own analytics, most "visitors" were automated. Industry figures vary widely and we have not verified a universal number. Bots, scrapers, AI crawlers, and headless browsers all trigger GA4 page loads and Vercel Analytics hits — but they never convert, rarely engage, and completely distort your understanding of what's working.

If you're making content decisions based on raw pageview or session counts, you're optimizing for bot behavior.

## How to Detect Bot Inflation

### 1. Compare GA4 Sessions to GSC Clicks

GSC clicks measure actual humans clicking your search result. GA4 sessions count every page load from every source. The ratio between them reveals your bot percentage.

| GA4:GSC Ratio | Bot Level | What It Means |
|---------------|-----------|---------------|
| 1-3x | Normal | Healthy mix of organic + social + direct |
| 3-5x | Moderate | Some bot traffic, monitor engagement rate |
| 5-10x | High | Most "direct" traffic is bots |
| 10x+ | Critical | Analytics are unreliable for any decision-making |

### 2. Check Direct Traffic Engagement

Pull your GA4 data filtered to the "Direct" channel. Real direct traffic (bookmarks, typed URLs) should have 40-60% engagement rate. If Direct engagement is below 15%, that channel is almost entirely bots.

### 3. The Engagement Rate Test

For any page or channel where you suspect bot inflation:
- **Engagement rate > 40%**: Mostly real traffic
- **Engagement rate 20-40%**: Mixed
- **Engagement rate < 20%**: Mostly bots

## What to Trust Instead

| Metric | Why |
|--------|-----|
| GSC clicks | Measures actual search result clicks — bots don't click search results |
| GA4 conversions | Bots don't fill out forms or click CTAs |
| Engaged sessions | Filters out single-pageview zero-interaction visits |
| Average session duration (engaged only) | Ignores 0-second bot visits |

## AI Referral Traffic

AI assistants that cite your content (ChatGPT, Claude, Gemini, Perplexity) send real traffic that's worth tracking separately. These users arrive with high intent — they asked an AI a question, got pointed to your page, and clicked through.

Benchmark from a site at ~5.6M impressions/month:
- ~450 sessions/month from AI referrals
- **171-second average session duration** (longest of any channel)
- High engagement rate (these users read deeply)

This validates AEO (AI Engine Optimization) investment. The volume is small today, but the quality is exceptional and growing.

## Setting Up Conversion Tracking

The single most important thing you can do is set up GA4 conversion events for real user actions:

```typescript
// Newsletter signup
gtag('event', 'newsletter_signup', {
  source: 'homepage_form',  // tag each form location
});

// Tool completion (calculators, scorers, etc.)
gtag('event', 'tool_complete', {
  tool_name: 'seo_score',
  result: score,
});

// Affiliate/CTA clicks
gtag('event', 'affiliate_click', {
  position: 'hero',  // hero / mid / footer
  destination: 'product_name',
});
```

Then mark these as **Key Events** in GA4 Admin → Events → toggle the "Mark as key event" switch. GA4 won't count them as conversions until you do this — shipping the code is only half the job.

## The Bottom Line

Don't optimize for bots. Use GSC clicks as your north-star traffic metric, GA4 conversions as your engagement metric, and ignore raw session/pageview counts entirely. Every content decision should be based on "did real humans find this useful?" — and only GSC and conversion data answer that question.

See `config/bot-traffic-rules.json` for the structured rules.
