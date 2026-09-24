/**
 * Same-event rewrite detection for news sites (see scripts/rewrite-detector.mjs).
 * Two stories that share a slug's first token and the same dollar amount are the same round
 * rewritten only if this returns true. Every guard exists because a looser rule, run over a
 * real archive, merged distinct stories: IPO filing vs debut, two unrelated "$1B" items,
 * Series C vs Series D, and an analysis piece vs the raise it discusses.
 */
export const FUNDING_SLUG = /(^|-)(raises?|raised|series|seed|round|funding|stealth|emerges|acquires?|acquisition|buys)(-|$)/;
export const NOT_A_REWRITE_SLUG = /(^|-)(ipo|revenue|run-rate|earnings|talks|stake|stakes|analysis|data|record|take|unlock|vs|h1|q[1-4]|tally|followup)(-|$)/;
export const AMOUNT_IN_SLUG = /(^|-)\d+(-\d+)?(m|b|k|bn|-million|-billion)(-|$)/;
const seriesLetter = (slug) => (slug.match(/(?:^|-)series-([a-z])(?:-|$)/) || [])[1];

export function sameRoundRewrite(x, y, { windowDays = 7 } = {}) {
  const tx = Date.parse(x.timestamp || ''), ty = Date.parse(y.timestamp || '');
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || Math.abs(ty - tx) > windowDays * 864e5) return false;
  if (!FUNDING_SLUG.test(x.slug) && !FUNDING_SLUG.test(y.slug)) return false;
  if (NOT_A_REWRITE_SLUG.test(x.slug) || NOT_A_REWRITE_SLUG.test(y.slug)) return false;
  if (!AMOUNT_IN_SLUG.test(x.slug) || !AMOUNT_IN_SLUG.test(y.slug)) return false;
  const sx = seriesLetter(x.slug), sy = seriesLetter(y.slug);
  return !(sx && sy && sx !== sy);
}
