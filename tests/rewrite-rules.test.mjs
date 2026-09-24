import { test } from "node:test";
import assert from "node:assert/strict";
import { sameRoundRewrite } from "../lib/rewrite-rules.mjs";
const s = (slug, day) => ({ slug, timestamp: `2026-07-${String(day).padStart(2, "0")}T12:00:00Z` });
test("rewrites merge", () => {
  assert.ok(sameRoundRewrite(s("encore-ai-30-million-series-a-2026", 29), s("encore-ai-30-million-series-a-customer-calls-2026", 29)));
  assert.ok(sameRoundRewrite(s("hadrian-1-37-billion-round-7-9-billion-valuation-2026", 6), s("hadrian-1-37b-series-d-7-87b-valuation-2026", 6)));
});
test("distinct stories stay separate", () => {
  assert.ok(!sameRoundRewrite(s("gatik-200-million-series-c-pepsico-2026", 25), s("gatik-200-million-series-d-qia-koch-2026", 28)));
  assert.ok(!sameRoundRewrite(s("openai-chatgpt-ads-1-billion-run-rate-2026", 1), s("openai-daybreak-1-billion-cyber-credits-2026", 4)));
  assert.ok(!sameRoundRewrite(s("cxmt-8-6b-shanghai-star-ipo-2026", 19), s("cxmt-star-market-debut-surge-2026", 27)));
  assert.ok(!sameRoundRewrite(s("windborne-ai-weather-forecasting-funding-2026", 5), s("windborne-systems-37m-weather-intelligence-2026", 5)));
});
