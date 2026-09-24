import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLE_RUNS, runSample } from './fixtures/gsc/samples.mjs';

// The committed samples must be exactly what the scripts produce from the fake rows.
// Regenerate with: node tests/fixtures/gsc/make-samples.mjs
for (const run of SAMPLE_RUNS) {
  test(`samples/${run.sample} matches ${run.script} output`, async () => {
    const committed = JSON.parse(readFileSync(new URL(`../samples/${run.sample}`, import.meta.url), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(await runSample(run))), committed);
  });
}
