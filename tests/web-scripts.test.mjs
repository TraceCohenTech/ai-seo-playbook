// Tests for the web, crawl and policy scripts. A local fixture server (node:http on 127.0.0.1)
// stands in for the site; the AI citation tracker uses mocked fetch. No external network, no credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, materialize } from './fixtures/web/server.mjs';

import { fileToRoute, routesFromDir, parseSitemap, joinBase } from '../scripts/redirect-checker.mjs';
import { extractLinks, resolveLink, hostThrottle, checkUrl } from '../scripts/broken-link-checker.mjs';
import { extractFromHtml, extractFromJsx, validatePage, parseJsLiteral } from '../scripts/schema-validator.mjs';
import { inspectFeed } from '../scripts/websub-ping.mjs';
import { eligibleType } from '../scripts/indexing-submitter.mjs';
import { runQuery, runTracker, hostMatches, openaiCitations, perplexityCitations } from '../scripts/ai-citation-tracker.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/web/', import.meta.url));
const execFileP = promisify(execFile);
const out = mkdtempSync(join(tmpdir(), 'web-scripts-out-'));

async function run(script, args, env = {}) {
  try {
    const r = await execFileP(process.execPath, [`scripts/${script}`, ...args], { cwd: ROOT, env: { ...process.env, PERPLEXITY_API_KEY: '', OPENAI_API_KEY: '', ...env }, timeout: 60000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

let srv;
let fx;
before(async () => { srv = await startServer(); fx = materialize(srv.origin); });
after(async () => { await srv.close(); });

// ---------------- redirect-checker ----------------

test('redirect-checker: App Router page.tsx maps to its directory route', () => {
  assert.deepEqual(fileToRoute('blog/foo-bar-post/page.tsx', { appRouter: true }), { route: '/blog/foo-bar-post' });
  assert.deepEqual(fileToRoute('page.tsx', { appRouter: true }), { route: '/' });
  assert.deepEqual(fileToRoute('(marketing)/about/page.tsx', { appRouter: true }), { route: '/about' });
  assert.ok(fileToRoute('blog/[slug]/page.tsx', { appRouter: true }).skip);
  assert.ok(fileToRoute('layout.tsx', { appRouter: true }).skip);
  assert.deepEqual(fileToRoute('guides/index.mdx', { appRouter: false }), { route: '/guides' });
  assert.deepEqual(fileToRoute('blog/crlf-post.md', { appRouter: false }), { route: '/blog/crlf-post' });
});

test('redirect-checker: routesFromDir uses path.relative (./dir works) and skips binaries', async () => {
  const app = await routesFromDir('./tests/fixtures/web/app'.replace('./', ROOT));
  assert.equal(app.appRouter, true);
  assert.deepEqual(app.routes.map((r) => r.route).sort(), ['/', '/about', '/blog/foo-bar-post']);
  assert.ok(app.skipped.some((s) => s.file === 'blog/[slug]/page.tsx'));
  assert.ok(app.skipped.some((s) => s.file === '@modal/page.tsx'));
  const content = await routesFromDir(join(FIX, 'content'));
  const routes = content.routes.map((r) => r.route);
  assert.ok(routes.includes('/blog/crlf-post') && routes.includes('/guides'));
  assert.ok(!routes.some((r) => r.includes('logo')));
  assert.equal(joinBase('http://127.0.0.1:9/', '/blog/foo'), 'http://127.0.0.1:9/blog/foo');
});

test('redirect-checker: parseSitemap decodes &amp; and CDATA and detects indexes', () => {
  const s = parseSitemap('<urlset><url><loc>https://example.com/s?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://example.com/x]]></loc></url></urlset>');
  assert.deepEqual(s.locs, ['https://example.com/s?a=1&b=2', 'https://example.com/x']);
  assert.equal(s.isIndex, false);
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>a</loc></sitemap></sitemapindex>').isIndex, true);
});

test('redirect-checker: sitemap index (incl. gzip) -> redirects, 404/410, 500; exit 2', async () => {
  const report = join(out, 'redirects.json');
  const r = await run('redirect-checker.mjs', ['--sitemap', `${srv.origin}/sitemap.xml`, '--output', report]);
  assert.equal(r.code, 2, r.stderr);
  const j = readJson(report);
  assert.equal(j.totalChecked, 9);
  assert.deepEqual(j.redirects.map((x) => x.url.replace(srv.origin, '')).sort(), ['/chain', '/old-post']);
  const chain = j.redirects.find((x) => x.url.endsWith('/chain'));
  assert.equal(chain.finalStatus, 200);
  assert.equal(chain.hops, 2);
  assert.deepEqual(j.notFound.map((x) => x.url.replace(srv.origin, '')).sort(), ['/gone', '/removed']);
  assert.deepEqual(j.httpErrors.map((x) => x.status), [500]);
  assert.equal(j.ok, 4); // includes /search?q=acme&page=2, which only answers 200 if &amp; was decoded
});

test('redirect-checker: --dir with App Router builds correct URLs; exit 0', async () => {
  const report = join(out, 'redirects-dir.json');
  const r = await run('redirect-checker.mjs', ['--dir', 'tests/fixtures/web/app', '--base-url', `${srv.origin}/`, '--output', report]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const j = readJson(report);
  assert.equal(j.totalChecked, 3);
  assert.equal(j.ok, 3);
});

test('redirect-checker: unreadable sitemap exits 1; --site is no longer accepted', async () => {
  assert.equal((await run('redirect-checker.mjs', ['--sitemap', `${srv.origin}/missing-sitemap.xml`])).code, 1);
  assert.equal((await run('redirect-checker.mjs', ['--site', 'sc-domain:example.com', '--sitemap', `${srv.origin}/sitemap.xml`])).code, 1);
});

// ---------------- broken-link-checker ----------------

test('broken-link-checker: extraction skips code blocks, mailto and templates; CRLF line numbers', () => {
  const md = readFileSync(join(FIX, 'content/blog/crlf-post.md'), 'utf8');
  assert.ok(md.includes('\r\n'));
  const links = extractLinks(md, '.md');
  const raws = links.map((l) => l.raw);
  assert.ok(raws.includes('./other-post.md') && raws.includes('other-post') && raws.includes('/gone'));
  assert.ok(!raws.includes('/inside-code-block'));
  assert.ok(!raws.some((r) => r.startsWith('mailto:')));
  assert.equal(links.find((l) => l.raw === '/gone').line, 9);
  const tsx = extractLinks('<a href={`/blog/${slug}`}>x</a><Link href="/a">a</Link> arr[0](fn)', '.tsx');
  assert.deepEqual(tsx.map((l) => l.raw), ['/a']);
});

test('broken-link-checker: relative links resolve against the file route; .md links resolve on disk', () => {
  const rootDir = join(FIX, 'content');
  const absFile = join(rootDir, 'blog/crlf-post.md');
  const ctx = { absFile, rootDir, appRouter: false, baseUrl: 'https://example.com' };
  assert.deepEqual(resolveLink('other-post', ctx), { kind: 'url', url: 'https://example.com/blog/other-post' });
  assert.deepEqual(resolveLink('/gone#x', ctx), { kind: 'url', url: 'https://example.com/gone' });
  const md = resolveLink('./other-post.md', ctx);
  assert.equal(md.kind, 'local');
  assert.equal(md.exists, true);
  assert.equal(resolveLink('../guides/missing.md', ctx).exists, false);
  assert.equal(resolveLink('../images/logo.png', ctx).kind, 'local');
  assert.equal(resolveLink('other-post', { ...ctx, baseUrl: undefined }).kind, 'needs-base');
  const appCtx = { absFile: join(FIX, 'app/(marketing)/about/page.tsx'), rootDir: join(FIX, 'app'), appRouter: true, baseUrl: 'https://example.com' };
  assert.equal(resolveLink('team', appCtx).url, 'https://example.com/team');
});

test('broken-link-checker: content dir -> broken/unverified/missing; exit 2', async () => {
  srv.log.length = 0;
  const report = join(out, 'links.json');
  const r = await run('broken-link-checker.mjs', ['--dir', join(fx, 'content'), '--base-url', srv.origin, '--rate', '50', '--output', report]);
  assert.equal(r.code, 2, r.stderr);
  const j = readJson(report);
  const broken = j.broken.map((b) => b.url.replace(srv.origin, '')).sort();
  assert.deepEqual(broken, ['/error', '/gone', '/removed']);
  assert.deepEqual(j.unverified.map((u) => u.url.replace(srv.origin, '')), ['/bot-wall']); // 403 after GET retry is not "broken"
  assert.deepEqual(j.missingLocalFiles.map((m) => m.target), ['guides/missing.md']);
  const requested = srv.log.map((l) => l.path);
  assert.ok(!requested.includes('/inside-code-block') && !requested.includes('/binary-junk'));
  assert.ok(!requested.some((p) => p.includes('logo.png')));
});

test('broken-link-checker: App Router dir; HEAD 405 falls back to GET; redirects reported', async () => {
  srv.log.length = 0;
  const report = join(out, 'links-app.json');
  const r = await run('broken-link-checker.mjs', ['--dir', join(fx, 'app'), '--base-url', srv.origin, '--rate', '50', '--output', report]);
  assert.equal(r.code, 2);
  const j = readJson(report);
  assert.deepEqual(j.broken.map((b) => b.url.replace(srv.origin, '')), ['/gone']);
  assert.deepEqual(j.redirected.map((b) => b.url.replace(srv.origin, '')), ['/old-post']);
  const hb = srv.log.filter((l) => l.path === '/head-blocked').map((l) => l.method);
  assert.deepEqual(hb, ['HEAD', 'GET']);
  assert.ok(srv.log.some((l) => l.path === '/team'));
});

test('broken-link-checker: relative links without --base-url exit 1', async () => {
  const r = await run('broken-link-checker.mjs', ['--dir', join(fx, 'content')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--base-url/);
});

test('broken-link-checker: per-host throttle spaces requests to one host only', async () => {
  const throttle = hostThrottle(10); // 100 ms interval
  const t0 = Date.now();
  await Promise.all([throttle('http://a.test/1'), throttle('http://a.test/2'), throttle('http://a.test/3'), throttle('http://b.test/1')]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 180, `elapsed ${elapsed}`);
  const t1 = Date.now();
  await throttle('http://c.test/1');
  assert.ok(Date.now() - t1 < 50);
  const fake = async (u, o) => ({ status: o.method === 'HEAD' ? 999 : 200, ok: o.method !== 'HEAD', url: u, redirected: false, body: null });
  const res = await checkUrl('http://d.test/x', { throttle: hostThrottle(1000), fetchImpl: fake });
  assert.equal(res.state, 'ok');
  assert.equal(res.method, 'GET');
});

// ---------------- schema-validator ----------------

test('schema-validator: @graph children inherit @context; Article has no required properties', () => {
  const blocks = extractFromHtml('<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article"},{"@type":"Organization","name":"Acme","url":"https://example.com","logo":"https://example.com/l.png"}]}</script>');
  const { issues, types } = validatePage(blocks);
  assert.deepEqual(types.sort(), ['Article', 'Organization']);
  assert.ok(!issues.some((i) => /@context/.test(i.message)));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
  assert.ok(issues.some((i) => i.severity === 'warn' && /recommended property "headline"/.test(i.message)));
});

test('schema-validator: author arrays are checked per author, no false missing url', () => {
  const { issues } = validatePage([{ value: { '@context': 'https://schema.org', '@type': 'Article', headline: 'h', image: 'i', datePublished: '2026-01-01', dateModified: '2026-01-02', author: [{ '@type': 'Person', name: 'A', url: 'https://example.com/a' }] } }]);
  assert.deepEqual(issues, []);
});

test('schema-validator: JSX dangerouslySetInnerHTML JSON-LD (const, inline, dynamic)', () => {
  const src = readFileSync(join(FIX, 'app/blog/foo-bar-post/page.tsx'), 'utf8');
  const blocks = extractFromJsx(src);
  assert.equal(blocks.length, 1);
  assert.deepEqual(validatePage(blocks).types.sort(), ['Article', 'FAQPage']);
  const inline = extractFromJsx(`<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Acme', url: 'https://example.com', }) }} />`);
  assert.equal(inline[0].value.name, 'Acme');
  const child = extractFromJsx(`<script type="application/ld+json">{JSON.stringify(schema)}</script>`);
  assert.ok(child[0].unresolved);
  const dyn = extractFromJsx(readFileSync(join(FIX, 'app/blog/[slug]/page.tsx'), 'utf8'));
  assert.ok(dyn[0].unresolved.includes('buildArticleSchema(post)'));
  assert.throws(() => parseJsLiteral('{ a: b }'));
  assert.deepEqual(parseJsLiteral("{ a: 'x', \"b\": [1, true, null,], /* c */ }").value, { a: 'x', b: [1, true, null] });
});

test('schema-validator: --sitemap index on rendered pages; duplicate FAQPage error; exit 2', async () => {
  const report = join(out, 'schema.json');
  const r = await run('schema-validator.mjs', ['--sitemap', `${srv.origin}/sitemap-schema.xml`, '--output', report]);
  assert.equal(r.code, 2, r.stderr);
  const j = readJson(report);
  assert.equal(j.totalScanned, 5);
  assert.equal(j.fetchErrors.length, 0);
  const dup = j.pages.find((p) => p.target.endsWith('/dup-faq'));
  assert.ok(dup.issues.some((i) => i.severity === 'error' && /Duplicate FAQPage/.test(i.message)));
  assert.ok(dup.issues.some((i) => /Invalid JSON/.test(i.message)));
  const all = JSON.stringify(j) + r.stdout;
  assert.ok(!/penalt/i.test(all) && !/max 5/i.test(all) && !/110/.test(all));
  assert.match(r.stdout, /authoritative government and health sites since Aug 2023/);
  const post = j.pages.find((p) => p.target.endsWith('/blog/foo-bar-post'));
  assert.equal(post.issues.filter((i) => i.severity !== 'info').length, 0);
});

test('schema-validator: --url fetch errors are surfaced and exit 1; clean page exits 0', async () => {
  const bad = await run('schema-validator.mjs', ['--url', `${srv.origin}/gone`]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /FETCH ERRORS/);
  const ok = await run('schema-validator.mjs', ['--url', `${srv.origin}/blog/plain`]);
  assert.equal(ok.code, 0, ok.stdout);
});

test('schema-validator: --dir source mode finds Next.js JSON-LD and reports unresolved blocks', async () => {
  const report = join(out, 'schema-src.json');
  const r = await run('schema-validator.mjs', ['--dir', 'tests/fixtures/web/app', '--output', report]);
  assert.equal(r.code, 2); // the fixture has a Question without acceptedAnswer
  const j = readJson(report);
  assert.equal(j.withSchemas, 1);
  assert.equal(j.unresolvedSourceBlocks, 1);
});

// ---------------- websub-ping ----------------

test('websub-ping: inspectFeed finds hub/self and recognises sitemaps', () => {
  const atom = inspectFeed('<feed xmlns="http://www.w3.org/2005/Atom"><link rel="hub" href="https://hub.example.com/"/><link href="https://example.com/feed.xml" rel="self"/></feed>');
  assert.deepEqual(atom, { kind: 'atom', hubs: ['https://hub.example.com/'], self: 'https://example.com/feed.xml' });
  assert.equal(inspectFeed('<urlset></urlset>').kind, 'sitemap');
  const hdr = inspectFeed('<rss><channel></channel></rss>', '<https://hub.example.com/>; rel="hub", <https://example.com/rss>; rel="self"');
  assert.deepEqual(hdr.hubs, ['https://hub.example.com/']);
});

test('websub-ping: pings only the declared hub; refuses sitemaps and hubless feeds (exit 2)', async () => {
  srv.hubPings.length = 0;
  const r = await run('websub-ping.mjs', ['--feeds', `${srv.origin}/feed.xml,${srv.origin}/rss-nohub.xml,${srv.origin}/sitemap.xml`]);
  assert.equal(r.code, 2);
  assert.deepEqual(srv.hubPings, [{ 'hub.mode': 'publish', 'hub.url': `${srv.origin}/feed.xml` }]);
  assert.ok(!/re-crawl/i.test(r.stdout));
});

test('websub-ping: a failing hub or missing feed exits 1; dry run sends nothing', async () => {
  assert.equal((await run('websub-ping.mjs', ['--feeds', `${srv.origin}/feed-bad-hub.xml`])).code, 1);
  assert.equal((await run('websub-ping.mjs', ['--feeds', `${srv.origin}/nope.xml`])).code, 1);
  srv.hubPings.length = 0;
  const d = await run('websub-ping.mjs', ['--feeds', `${srv.origin}/feed.xml`, '--dry-run']);
  assert.equal(d.code, 0);
  assert.equal(srv.hubPings.length, 0);
});

// ---------------- indexing-submitter ----------------

test('indexing-submitter: only JobPosting or VideoObject+BroadcastEvent qualify', () => {
  const page = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  assert.equal(eligibleType(page({ '@type': 'JobPosting' })), 'JobPosting');
  assert.equal(eligibleType(page({ '@graph': [{ '@type': 'VideoObject', publication: { '@type': 'BroadcastEvent' } }] })), 'BroadcastEvent');
  assert.equal(eligibleType(page({ '@type': 'VideoObject' })), null);
  assert.equal(eligibleType(page({ '@type': 'BroadcastEvent' })), null);
  assert.equal(eligibleType(page({ '@type': 'Article' })), null);
});

test('indexing-submitter: dry run refuses articles (exit 2), shows the policy banner', async () => {
  const report = join(out, 'indexing.json');
  const r = await run('indexing-submitter.mjs', ['--dry-run', '--urls', ['/jobs/acme-engineer', '/live/acme-launch', '/blog/plain'].map((p) => srv.origin + p).join(','), '--output', report]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /ONLY pages with JobPosting/);
  assert.match(r.stdout, /200 publish requests per day per Google Cloud project/);
  const j = readJson(report);
  assert.deepEqual(j.checks.map((c) => c.eligible), [true, true, false]);
  assert.equal(j.submissions.length, 0);
  const ok = await run('indexing-submitter.mjs', ['--dry-run', '--urls', `${srv.origin}/jobs/acme-engineer`]);
  assert.equal(ok.code, 0);
});

test('indexing-submitter: URL_DELETED requires 404/410', async () => {
  const r = await run('indexing-submitter.mjs', ['--dry-run', '--type', 'URL_DELETED', '--urls', `${srv.origin}/jobs/filled-role,${srv.origin}/blog/plain`, '--output', join(out, 'del.json')]);
  assert.equal(r.code, 2);
  assert.deepEqual(readJson(join(out, 'del.json')).checks.map((c) => c.eligible), [true, false]);
});

// ---------------- ai-citation-tracker (mocked fetch) ----------------

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('ai-citation-tracker: exact host match, not substring', () => {
  assert.ok(hostMatches('https://www.example.com/a', 'example.com'));
  assert.ok(hostMatches('https://example.com/a', 'www.example.com'));
  assert.ok(!hostMatches('https://notexample.com/a', 'example.com'));
  assert.ok(!hostMatches('https://example.com.evil.test/a', 'example.com'));
  assert.ok(!hostMatches('https://blog.example.com/a', 'example.com'));
  assert.ok(hostMatches('https://blog.example.com/a', 'example.com', true));
  assert.ok(!hostMatches('https://other.test/?ref=example.com', 'example.com'));
});

test('ai-citation-tracker: Perplexity citations -> cited / not cited, with provenance', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    const prompt = JSON.parse(opts.body).messages[0].content;
    return jsonRes(200, { model: 'sonar', citations: prompt.includes('acme') ? ['https://www.example.com/blog/acme', 'https://other.test/x'] : ['https://notexample.com/y'] });
  };
  const hit = await runQuery('perplexity', 'what is acme', { apiKey: 'k', model: 'sonar', domain: 'example.com', fetchImpl });
  assert.equal(hit.status, 'cited');
  assert.deepEqual(hit.matchedCitations, ['https://www.example.com/blog/acme']);
  assert.equal(hit.provider, 'perplexity');
  assert.equal(hit.model, 'sonar');
  assert.equal(hit.prompt, 'what is acme');
  assert.ok(!Number.isNaN(Date.parse(hit.date)));
  const miss = await runQuery('perplexity', 'something else', { apiKey: 'k', model: 'sonar', domain: 'example.com', fetchImpl });
  assert.equal(miss.status, 'not_cited');
  assert.equal(calls[0].url, 'https://api.perplexity.ai/chat/completions');
  assert.equal(calls[0].auth, 'Bearer k');
  assert.deepEqual(perplexityCitations({ search_results: [{ url: 'https://example.com/z' }] }), ['https://example.com/z']);
});

test('ai-citation-tracker: non-2xx is an ERROR, never "not cited", and is excluded from the rate', async () => {
  let n = 0;
  const fetchImpl = async () => (n++ === 0 ? jsonRes(403, { error: { message: 'forbidden' } }) : jsonRes(200, { citations: ['https://example.com/a'] }));
  const report = await runTracker({ prompts: ['p1', 'p2'], domain: 'example.com', providers: ['perplexity'], models: { perplexity: 'sonar' }, keys: { perplexity: 'k' }, delayMs: 0, fetchImpl });
  assert.equal(report.results[0].status, 'error');
  assert.equal(report.results[0].httpStatus, 403);
  assert.equal(report.results[1].status, 'cited');
  assert.deepEqual(report.summary.perplexity, { model: 'sonar', queries: 2, completed: 1, cited: 1, notCited: 0, errors: 1, citationRate: 100 });
  assert.match(report.measurement, /Sampled measurement/);
  const netErr = await runQuery('perplexity', 'p', { apiKey: 'k', model: 'sonar', domain: 'example.com', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(netErr.status, 'error');
});

test('ai-citation-tracker: OpenAI Responses url_citation annotations', async () => {
  const body = {
    model: 'gpt-4.1-mini-2025-04-14',
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Acme builds widgets.', annotations: [{ type: 'url_citation', start_index: 0, end_index: 4, url: 'https://example.com/acme?utm_source=openai', title: 'Acme' }] }] },
    ],
  };
  assert.deepEqual(openaiCitations(body), ['https://example.com/acme?utm_source=openai']);
  let sent;
  const r = await runQuery('openai', 'what is acme', { apiKey: 'k', model: 'gpt-4.1-mini', domain: 'example.com', fetchImpl: async (url, o) => { sent = { url, body: JSON.parse(o.body) }; return jsonRes(200, body); } });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(sent.body.tools, [{ type: 'web_search' }]);
  assert.equal(r.status, 'cited');
  assert.equal(r.webSearchCalled, true);
  assert.equal(r.modelReturned, 'gpt-4.1-mini-2025-04-14');
});

test('ai-citation-tracker: CLI refuses to run without an API key (exit 1)', async () => {
  const r = await run('ai-citation-tracker.mjs', ['--domain', 'example.com', '--queries', join(FIX, 'prompts.txt')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PERPLEXITY_API_KEY/);
});
