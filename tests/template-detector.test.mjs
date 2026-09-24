import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPhrases, compilePhrases, findPhrases, scanDocuments } from '../scripts/template-detector.mjs';
import { extractVisibleText } from '../scripts/thin-content-detector.mjs';
import { ROOT, fx, read, run, tmp } from './_content-helpers.mjs';

test('phrases are loaded from config/anti-ai-rules.json', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config/anti-ai-rules.json'), 'utf8'));
  const expected = Object.values(cfg.blockedPhrases).flat().length;
  const phrases = loadPhrases();
  assert.equal(phrases.length, expected);
  assert.ok(phrases.some((p) => p.phrase === "it's worth noting" && p.category === 'hedging'));
});

test('overlapping phrases count once; curly apostrophes and line breaks match', () => {
  const compiled = compilePhrases(loadPhrases());
  const hits = findPhrases('In this article, we’ll explore pools. It’s worth\nnoting that pools vary.', compiled);
  assert.deepEqual(hits.map((h) => h.phrase), ["in this article, we'll explore", "it's worth noting"]);
});

test('TSX bodies are scanned (text inside JSX), attributes are not', () => {
  const compiled = compilePhrases([{ phrase: 'warehouse automation', category: 'x' }, { phrase: 'prose mx-auto', category: 'x' }]);
  const text = extractVisibleText(read('app/blog/why-vcs-dont-return-calls/page.tsx'), '.tsx');
  assert.deepEqual(findPhrases(text, compiled).map((h) => h.phrase), ['warehouse automation']);
});

test('scanDocuments reports categories, per-file phrases and thresholds', () => {
  const compiled = compilePhrases(loadPhrases());
  const docs = ['posts/crlf-post.md', 'posts/linking-post.mdx', 'posts/old-thin.md'].map((f) => ({ file: f, text: extractVisibleText(read(f), '.' + f.split('.').pop()) }));
  const r = scanDocuments(docs, compiled, 2);
  assert.deepEqual(r.knownPatterns.map((p) => p.phrase).sort(), ["it's worth noting", "let's dive in", 'the bottom line:']);
  assert.equal(r.byCategoryCount.templateOpeners, 3);
  assert.equal(r.flaggedFiles.length, 3);
});

test('CLI --config overrides the phrase list; report written with --output', () => {
  const dir = tmp();
  const cfg = join(dir, 'rules.json');
  writeFileSync(cfg, JSON.stringify({ blockedPhrases: { custom: ['option pool'] } }));
  const out = join(dir, 'scan.json');
  const r = run('template-detector.mjs', ['--dir', fx('posts'), '--config', cfg, '--threshold', '1', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(rep.knownPatterns.map((p) => p.phrase), ['option pool']);
  assert.equal(rep.knownPatterns[0].category, 'custom');
});

test('CLI: bad config is an error (exit 1)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'bad.json'), '{"nope": 1}');
  assert.equal(run('template-detector.mjs', ['--dir', fx('posts'), '--config', join(dir, 'bad.json')]).status, 1);
});
