#!/usr/bin/env node
/**
 * Traffic Guard: daily Search Console drop alarm (the one we wish we'd had).
 *
 * A middleware change once served `X-Robots-Tag: noindex` on every public page for 28 hours.
 * Daily impressions fell ~55% before anyone noticed, because 28-day rolling reports smooth a
 * cliff into a slope. This checks the last COMPLETE day (today-3; GSC's newest days are
 * provisional) against three baselines:
 *   1. same weekday, previous 2 weeks (handles weekend seasonality)
 *   2. previous 7 days
 *   3. same weekday 4-5 weeks back, clicks only (after an incident the short baselines
 *      are themselves depressed, which would hide a slow or partial recovery)
 * It alerts when the day is below --threshold (0.75) of BOTH 1 and 2, or clicks are below
 * --long-threshold (0.70) of 3. Exit 0 = ok, 2 = alert (wire it to CI or cron), 1 = error.
 * Optional --webhook posts the alert (ntfy, Slack incoming webhook, …).
 *
 * Usage: node scripts/traffic-guard.mjs --site sc-domain:example.com [--day YYYY-MM-DD] [--webhook https://ntfy.sh/your-topic]
 */
import { cli } from '../lib/cli.mjs';
import { gscClient, queryAll, isoDay, daysAgo } from '../lib/gsc.mjs';

const a = cli(import.meta.url, {
  site: { type: 'string', required: true }, day: { type: 'string' }, threshold: { type: 'string', default: '0.75' },
  'long-threshold': { type: 'string', default: '0.70' }, webhook: { type: 'string' },
});

const D = a.day ? new Date(a.day + 'T00:00:00Z') : daysAgo(3);
const back = (n) => { const x = new Date(D); x.setUTCDate(x.getUTCDate() - n); return isoDay(x); };
const sc = await gscClient();
const rows = await queryAll(sc, a.site, { startDate: back(38), endDate: isoDay(D), dimensions: ['date'] });
const by = new Map(rows.map((r) => [r.keys[0], r]));
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const T = Number(a.threshold), LT = Number(a['long-threshold']);
const day = by.get(isoDay(D));
const out = [];
let alert = !day;
for (const m of ['clicks', 'impressions']) {
  const v = day?.[m];
  const weekday = median([7, 14].map((n) => by.get(back(n))?.[m]));
  const prior7 = median([1, 2, 3, 4, 5, 6, 7].map((n) => by.get(back(n))?.[m]));
  const long = median([28, 35].map((n) => by.get(back(n))?.[m]));
  const hit = (v < T * weekday && v < T * prior7) || (m === 'clicks' && Number.isFinite(long) && v < LT * long);
  alert ||= hit;
  out.push(`${m}=${v ?? 'MISSING'} (weekday ${weekday} / 7d ${prior7}${m === 'clicks' ? ` / 4-5wk ${long}` : ''})${hit ? ' ⚠' : ''}`);
}
const line = `traffic-guard ${isoDay(D)} ${out.join(' · ')} → ${alert ? 'ALERT' : 'ok'}`;
console.log(line);
if (alert && a.webhook) {
  const slack = a.webhook.includes('hooks.slack.com');
  await fetch(a.webhook, { method: 'POST', headers: slack ? { 'content-type': 'application/json' } : { Title: 'Search traffic drop' }, body: slack ? JSON.stringify({ text: line }) : line }).catch(() => {});
}
process.exit(alert ? 2 : 0);
