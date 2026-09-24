import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factSpans, countFacts, countEntities, scoreText, per1K } from '../scripts/factual-density-scorer.mjs';
import { extractVisibleText } from '../scripts/thin-content-detector.mjs';
import { fx, read, run, tmp } from './_content-helpers.mjs';

test('"$6.6 billion" is one fact, not two', () => {
  assert.deepEqual(factSpans('Acme raised $6.6 billion.').map((s) => s.match), ['$6.6 billion']);
  const text = extractVisibleText(read('posts/density-report.md'), '.md');
  // 12 x "$6.6 billion" + "March 2025" + "Q1 2026"; bare years 2024/2019/2021 are not facts.
  assert.equal(countFacts(text), 14);
});

test('bare years are not facts; qualified dates are', () => {
  assert.equal(countFacts('The company was founded in 2019 and moved in 2021.'), 0);
  assert.equal(countFacts('It hired a CFO in March 2025 and reported Q1 2026 and FY2025 results on 2026-03-15.'), 4);
});

test('VC-specific patterns are opt-in', () => {
  assert.equal(countFacts('Acme closed its Series B.'), 0);
  assert.equal(countFacts('Acme closed its Series B.', { vc: true }), 1);
  assert.equal(countEntities('Acme filed with the SEC before its IPO.'), 0);
  assert.equal(countEntities('Acme filed with the SEC before its IPO.', { vc: true }), 2);
  assert.equal(countEntities('A partner at Example Capital met Acme Robotics Inc today.'), 2);
});

test('TSX paragraphs are split per block element', () => {
  const s = scoreText(extractVisibleText(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx'));
  assert.ok(s.totalParagraphs >= 8, String(s.totalParagraphs));
  assert.ok(s.paragraphsWithoutFacts < s.totalParagraphs);
  assert.equal(s.factCount, 3); // 40%, March 2025, $6.6 billion
});

test('densities are per 1,000 words', () => {
  assert.equal(per1K(3, 1000), 3);
  assert.equal(per1K(1, 440), 2.3);
  const s = scoreText('word '.repeat(995) + 'grew 42% to $3M in March 2026.');
  assert.equal(s.factsPer1K, per1K(3, s.wordCount));
});

test('help and output carry no unverified citation or "helpful content system" claims', () => {
  const h = run('factual-density-scorer.mjs', ['--help']).stdout;
  assert.ok(!/3-5x|helpful content/i.test(h));
  assert.match(h, /heuristic/);
  const out = join(tmp(), 'fd.json');
  const r = run('factual-density-scorer.mjs', ['--dir', fx(''), '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(rep.unit, 'per 1,000 words');
  assert.ok(rep.files.every((f) => 'factsPer1K' in f && 'entitiesPer1K' in f));
});
