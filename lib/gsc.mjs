/** Shared Search Console helpers: auth via Application Default Credentials, paging past 25K rows. */
import { google } from 'googleapis';

export async function gscClient() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  return google.searchconsole({ version: 'v1', auth: await auth.getClient() });
}

export const isoDay = (d) => d.toISOString().slice(0, 10);
export const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };

/** Query all rows (pages through the 25,000-row API cap). GSC's newest ~3 days are provisional; default end = 3 days ago. */
export async function queryAll(sc, site, { startDate, endDate, dimensions, filters, dataState = 'all' }) {
  const rows = [];
  for (let startRow = 0; ; startRow += 25000) {
    const res = await sc.searchanalytics.query({
      siteUrl: site,
      requestBody: { startDate, endDate, dimensions, rowLimit: 25000, startRow, dataState, ...(filters ? { dimensionFilterGroups: [{ filters }] } : {}) },
    });
    const got = res.data.rows || [];
    rows.push(...got);
    if (got.length < 25000) return rows;
  }
}
