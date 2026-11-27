#!/usr/bin/env node
/** Write the static CLI fixtures (sitewide scenario) in three formats: node tests/fixtures/filter/make-fixtures.mjs */
import { writeFileSync } from 'node:fs';
import { scenario } from './scenarios.mjs';

const { pages, countries, devices } = scenario('sitewide');
const at = (f) => new URL(f, import.meta.url);
// pages: JSONL, flat rows
writeFileSync(at('pages.jsonl'), pages.map((r) => JSON.stringify({ page: r.key, date: r.date, clicks: r.clicks, impressions: r.impressions, position: r.position })).join('\n') + '\n');
// countries: CSV with Search Console style headers
writeFileSync(at('countries.csv'), 'Country,Date,Clicks,Impressions,CTR,Position\n' +
  countries.map((r) => `${r.key},${r.date},${r.clicks},"${r.impressions.toLocaleString('en-US')}",${((r.clicks / r.impressions) * 100).toFixed(2)}%,${r.position}`).join('\n') + '\n');
// devices: JSON array of GSC API rows
writeFileSync(at('devices.json'), JSON.stringify(devices.map((r) => ({ keys: [r.key, r.date], clicks: r.clicks, impressions: r.impressions, ctr: r.clicks / r.impressions, position: r.position }))) + '\n');
console.log('wrote tests/fixtures/filter/{pages.jsonl,countries.csv,devices.json}');
