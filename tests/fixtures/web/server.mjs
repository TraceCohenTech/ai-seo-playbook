// Local fixture web server for the web/crawl tests. Binds 127.0.0.1 on a random port; no external network.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, cpSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const site = (f) => readFileSync(new URL(`./site/${f}`, import.meta.url), 'utf8');

export async function startServer() {
  const log = [];
  const hubPings = [];
  let origin;
  const page = (f, type = 'text/html; charset=utf-8') => ({ status: 200, type, body: () => site(f).replaceAll('FIXTURE_ORIGIN', origin) });
  const html = (title) => ({ status: 200, type: 'text/html; charset=utf-8', body: () => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${title}</body></html>` });
  const routes = {
    '/': html('Acme Insights'),
    '/about': html('About Acme'),
    '/team': html('Acme team'),
    '/blog': html('Blog'),
    '/blog/foo-bar-post': page('blog-foo-bar-post.html'),
    '/blog/other-post': html('Other post'),
    '/blog/crlf-post': html('CRLF post'),
    '/blog/plain': page('plain.html'),
    '/guides/intro': html('Intro'),
    '/dup-faq': page('dup-faq.html'),
    '/jobs/acme-engineer': page('job.html'),
    '/live/acme-launch': page('live.html'),
    '/feed.xml': page('feed.xml', 'application/atom+xml'),
    '/feed-bad-hub.xml': page('feed-bad-hub.xml', 'application/rss+xml'),
    '/rss-nohub.xml': page('rss-nohub.xml', 'application/rss+xml'),
    '/sitemap.xml': page('sitemap.xml', 'application/xml'),
    '/sitemap-pages.xml': page('sitemap-pages.xml', 'application/xml'),
    '/sitemap-schema.xml': page('sitemap-schema.xml', 'application/xml'),
    '/sitemap-schema-pages.xml': page('sitemap-schema-pages.xml', 'application/xml'),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, origin);
    log.push({ method: req.method, path: url.pathname + url.search, t: Date.now() });
    const send = (status, headers = {}, body = '') => { res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body); };
    const p = url.pathname;
    if (p === '/hub' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { hubPings.push(Object.fromEntries(new URLSearchParams(body))); send(204); });
      return;
    }
    if (p === '/hub-broken') return send(500, {}, 'hub error');
    if (p === '/search') return url.search === '?q=acme&page=2' ? send(200, { 'content-type': 'text/html' }, '<title>Search</title>') : send(404);
    if (p === '/sitemap-posts.xml.gz') return send(200, { 'content-type': 'application/gzip' }, gzipSync(site('sitemap-posts.xml').replaceAll('FIXTURE_ORIGIN', origin)));
    if (p === '/old-post') return send(301, { location: '/blog/foo-bar-post' });
    if (p === '/chain') return send(302, { location: `${origin}/old-post` });
    if (p === '/gone' || p === '/inside-code-block' || p === '/binary-junk') return send(404, {}, 'not found');
    if (p === '/removed' || p === '/jobs/filled-role') return send(410, {}, 'gone');
    if (p === '/error') return send(500, {}, 'server error');
    if (p === '/head-blocked') return req.method === 'HEAD' ? send(405) : send(200, { 'content-type': 'text/html' }, '<title>ok</title>');
    if (p === '/bot-wall') return send(403, {}, 'Just a moment...');
    const r = routes[p];
    if (r) return send(r.status, { 'content-type': r.type }, r.body());
    return send(404, {}, 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, log, hubPings, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Copy app/ and content/ fixtures to a temp dir, replacing FIXTURE_ORIGIN in text files with `origin`. */
export function materialize(origin) {
  const tmp = mkdtempSync(join(tmpdir(), 'web-fixture-'));
  for (const sub of ['app', 'content']) cpSync(fileURLToPath(new URL(`./${sub}`, import.meta.url)), join(tmp, sub), { recursive: true });
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|mdx|tsx|jsx|html)$/.test(f)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('FIXTURE_ORIGIN', origin));
    }
  };
  walk(tmp);
  return tmp;
}
