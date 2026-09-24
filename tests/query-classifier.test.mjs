import { test } from "node:test";
import assert from "node:assert/strict";
import { isHumanQuery, isZeroClickAgent, splitQueries } from "../lib/query-classifier.mjs";

test("human-shaped queries", () => {
  for (const q of ["openai revenue 2026", "how much is openai worth", "perplexity valuation", "devin pricing", "vc funding september 2026", "yc acceptance rate"]) assert.ok(isHumanQuery(q), q);
});
test("machine-shaped queries", () => {
  for (const q of ['"cognition hits $47 billion"', "site:abc.xyz 2026", "ai87714", "how much money has alipacocinas.com raised",
    "semiconductor startup series b funding august 2026", "aws ai news june 26 2026", "bill gates family office biotech funding 2022-2026",
    "evaluate the ai infrastructure and high-performance computing vendors"]) assert.ok(!isHumanQuery(q), q);
});
test("behavioural zero-click agent", () => {
  assert.ok(isZeroClickAgent({ impressions: 93365, clicks: 0, position: 3.7 }));
  assert.ok(!isZeroClickAgent({ impressions: 93365, clicks: 12, position: 3.7 }));
  assert.ok(!isZeroClickAgent({ impressions: 120, clicks: 0, position: 3 }));
});
test("splitQueries", () => {
  const { human, machine } = splitQueries([{ query: "openai revenue 2026", impressions: 1000, clicks: 28, position: 3 }, { query: "tiger global aum 2026 long short", impressions: 93000, clicks: 0, position: 3.7 }]);
  assert.equal(human.length, 1); assert.equal(machine.length, 1);
});
