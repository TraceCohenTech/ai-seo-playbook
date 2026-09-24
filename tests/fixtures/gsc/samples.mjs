/**
 * The runs that produce samples/*.json from the fake GSC rows. Used by make-samples.mjs
 * (writes them) and tests/gsc-samples.test.mjs (checks the committed samples still match).
 */
import { fileURLToPath } from 'node:url';
import { makeClient, SITE, TODAY } from './dataset.mjs';

const siteDir = fileURLToPath(new URL('./site/', import.meta.url));

export const SAMPLE_RUNS = [
  { sample: 'weekly-report.json', script: 'weekly-report', opts: {} },
  { sample: 'cannibal-clusters.json', script: 'cannibalization-detector', opts: { brand: ['example capital'] } },
  { sample: 'rewrite-candidates.json', script: 'gsc-rewrite-candidates', opts: {} },
  { sample: 'ctr-audit.json', script: 'ctr-audit', opts: {} },
  { sample: 'striking-distance.json', script: 'striking-distance', opts: {} },
  { sample: 'query-gap-miner.json', script: 'query-gap-miner', opts: { dir: siteDir, minImpressions: 500 } },
];

export async function runSample({ script, opts }) {
  const mod = await import(`../../../scripts/${script}.mjs`);
  return mod.buildReport(makeClient(), { site: SITE, today: TODAY, now: TODAY, ...opts });
}
