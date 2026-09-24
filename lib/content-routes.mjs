/**
 * Map content files to site routes, titles and dates (used by refresh-tracker and
 * query-gap-miner).
 *
 * Next.js App Router: `app/blog/foo/page.tsx` serves `/blog/foo`. The slug is the PARENT
 * DIRECTORY of page.*, never "page". Route groups `(marketing)` and parallel slots `@modal`
 * are dropped; dynamic segments (`[slug]`, `[...all]`) cannot be mapped to one URL, so those
 * files get route null. Other files inside `app/` (layout.tsx, components) are not routes.
 *
 * Pages Router: `pages/blog/foo.tsx` serves `/blog/foo` (`_app`, `_document`, `api/` skipped).
 *
 * Markdown/MDX (and .tsx/.jsx outside app/ and pages/): the route is the path relative to the
 * scanned directory, without extension (`index` maps to its folder), prefixed with `urlPrefix`
 * when given.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, extname, basename } from 'node:path';

export const CONTENT_EXTS = new Set(['.md', '.mdx', '.tsx', '.jsx', '.ts', '.js']);
const PAGE_FILE = /^page\.(tsx|jsx|ts|js|mdx|md)$/;

/** rel: path relative to the scanned dir (any separator). Returns { route, slug, kind } or null. */
export function routeFor(rel, { urlPrefix = '' } = {}) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1];
  const appIdx = parts.lastIndexOf('app');
  if (appIdx !== -1 && appIdx < parts.length - 1) {
    if (!PAGE_FILE.test(file)) return null; // layout.tsx, components, etc.
    const segs = parts.slice(appIdx + 1, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    if (segs.some((s) => s.startsWith('['))) return { route: null, slug: null, kind: 'app-dynamic' };
    const route = '/' + segs.join('/');
    return { route: route === '/' ? '/' : route, slug: segs[segs.length - 1] || '', kind: 'app' };
  }
  const ext = extname(file);
  if (!CONTENT_EXTS.has(ext)) return null;
  let segs;
  const pagesIdx = parts.lastIndexOf('pages');
  if (pagesIdx !== -1 && pagesIdx < parts.length - 1) {
    // Pages Router: pages/blog/foo.tsx -> /blog/foo; skip _app/_document and API routes.
    segs = [...parts.slice(pagesIdx + 1, -1), basename(file, ext)];
    if (segs[0] === 'api' || segs.some((s) => s.startsWith('_'))) return null;
    if (segs.some((s) => s.startsWith('['))) return { route: null, slug: null, kind: 'pages-dynamic' };
  } else {
    if (!['.md', '.mdx', '.tsx', '.jsx'].includes(ext)) return null; // plain .ts/.js outside app/ or pages/ is code
    if (/^(layout|template|loading|error|not-found|route|default)\./.test(file)) return null;
    segs = [...parts.slice(0, -1), basename(file, ext)];
  }
  if (segs[segs.length - 1] === 'index') segs = segs.slice(0, -1);
  const prefix = String(urlPrefix || '').replace(/\/+$/, '');
  const route = (prefix + '/' + segs.join('/')).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return { route, slug: segs[segs.length - 1] || '', kind: pagesIdx !== -1 ? 'pages' : 'file' };
}

/** Title from frontmatter, a metadata/`title:` property, or the first <h1>/# heading. CRLF-safe. */
export function extractTitle(text) {
  const t = text.replace(/\r\n?/g, '\n');
  const fm = t.match(/^---\n([\s\S]*?)\n---/);
  const fromFm = fm && fm[1].match(/^title:\s*(.+)$/m);
  if (fromFm) return clean(fromFm[1]);
  const prop = t.match(/\btitle\s*:\s*(['"`])((?:(?!\1).)+)\1/);
  if (prop) return prop[2].trim();
  const h1 = t.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || t.match(/^#\s+(.+)$/m);
  return h1 ? clean(h1[1].replace(/<[^>]+>|\{[^}]*\}/g, ' ')) : '';
}
const clean = (s) => s.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').trim();

/**
 * Last-updated date from content: lastUpdated / updated / dateModified / modified, else
 * date / datePublished. Returns { date: 'YYYY-MM-DD', field } or null.
 */
export function extractUpdated(text) {
  const t = text.replace(/\r\n?/g, '\n');
  for (const field of ['lastUpdated', 'updated', 'dateModified', 'modified', 'date', 'datePublished']) {
    const m = t.match(new RegExp(`(?:^|[\\s{,"'])${field}["']?\\s*[:=]\\s*["'\`]?(\\d{4}-\\d{2}-\\d{2})`, 'm'));
    if (m) return { date: m[1], field };
  }
  return null;
}

/** Walk dir; returns [{ file, rel, route, slug, kind, title, updated, mtime }] for routable text files. */
export async function scanContent(dir, { urlPrefix = '' } = {}) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const rel = relative(dir, full).split(sep).join('/');
      const r = routeFor(rel, { urlPrefix });
      if (!r) continue;
      const text = await readFile(full, 'utf8');
      if (text.includes('\u0000')) continue; // binary with a text extension
      out.push({ file: full, rel, ...r, title: extractTitle(text), updated: extractUpdated(text), mtime: (await stat(full)).mtime });
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
