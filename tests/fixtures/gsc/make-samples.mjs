#!/usr/bin/env node
/** Regenerate samples/*.json for the GSC scripts from the fake rows: node tests/fixtures/gsc/make-samples.mjs */
import { writeFileSync } from 'node:fs';
import { SAMPLE_RUNS, runSample } from './samples.mjs';

for (const run of SAMPLE_RUNS) {
  const out = new URL(`../../../samples/${run.sample}`, import.meta.url);
  writeFileSync(out, JSON.stringify(await runSample(run), null, 2) + '\n');
  console.log(`wrote samples/${run.sample}`);
}
