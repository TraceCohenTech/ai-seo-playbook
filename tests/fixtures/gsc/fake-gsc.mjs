/**
 * In-memory stand-in for the Search Console API client (`sc.searchanalytics.query`), for
 * offline tests. Give it daily rows { date, page, query, clicks, impressions, position }; it
 * filters by date range, dataState and dimensionFilterGroups, aggregates by the requested
 * dimensions (summing clicks/impressions, impression-weighted position), sorts by clicks like
 * the real API, and honours rowLimit/startRow paging.
 *
 * `finalThrough`: rows dated after it are "provisional" and only returned for dataState 'all'
 * (the real API defaults to 'final').
 */
export function fakeGsc(rows, { finalThrough } = {}) {
  const calls = [];
  const matches = (f, r) => {
    const v = String(r[f.dimension] ?? '');
    const x = String(f.expression);
    switch (f.operator || 'equals') {
      case 'equals': return v === x;
      case 'notEquals': return v !== x;
      case 'contains': return v.includes(x);
      case 'notContains': return !v.includes(x);
      default: throw new Error(`fakeGsc: unsupported operator ${f.operator}`);
    }
  };
  async function query({ siteUrl, requestBody: rb }) {
    calls.push({ siteUrl, ...rb });
    const dims = rb.dimensions || [];
    const filters = (rb.dimensionFilterGroups || []).flatMap((g) => g.filters || []);
    const m = new Map();
    for (const r of rows) {
      if (r.date < rb.startDate || r.date > rb.endDate) continue;
      if ((rb.dataState || 'final') !== 'all' && finalThrough && r.date > finalThrough) continue;
      if (!filters.every((f) => matches(f, r))) continue;
      const keys = dims.map((d) => r[d]);
      const k = JSON.stringify(keys);
      let e = m.get(k);
      if (!e) m.set(k, (e = { keys, clicks: 0, impressions: 0, pw: 0 }));
      e.clicks += r.clicks; e.impressions += r.impressions; e.pw += r.position * r.impressions;
    }
    const out = [...m.values()]
      .filter((e) => e.impressions > 0)
      .map((e) => ({ keys: e.keys, clicks: e.clicks, impressions: e.impressions, ctr: e.clicks / e.impressions, position: e.pw / e.impressions }))
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys)));
    const start = rb.startRow || 0, limit = rb.rowLimit || 1000;
    return { data: { rows: out.slice(start, start + limit) } };
  }
  return { calls, searchanalytics: { query } };
}
