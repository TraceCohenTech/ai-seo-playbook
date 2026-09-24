// Regenerate samples/ for the web, crawl and policy scripts from real runs against the local
// fixture server (the AI citation tracker uses a mocked fetch). The random local origin is
// rewritten to https://example.com. Run: node tests/fixtures/web/make-samples.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, materialize } from './server.mjs';
import { runTracker } from '../../../scripts/ai-citation-tracker.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'web-samples-'));
const srv = await startServer();
const fx = materialize(srv.origin);
const clean = (s) => s.replaceAll(srv.origin, 'https://example.com').replaceAll(fx, './site-src');

async function sample(name, script, args) {
  const file = join(out, name);
  try { await promisify(execFile)(process.execPath, [`scripts/${script}`, ...args, '--output', file], { cwd: ROOT }); } catch { /* findings exit 2 */ }
  writeFileSync(join(ROOT, 'samples', name), clean(readFileSync(file, 'utf8')));
  console.log(`samples/${name}`);
}

try {
  await sample('redirect-check.json', 'redirect-checker.mjs', ['--sitemap', `${srv.origin}/sitemap.xml`]);
  await sample('broken-links.json', 'broken-link-checker.mjs', ['--dir', join(fx, 'content'), '--base-url', srv.origin, '--rate', '50']);
  await sample('schema-report.json', 'schema-validator.mjs', ['--sitemap', `${srv.origin}/sitemap-schema.xml`]);
  await sample('websub-ping.json', 'websub-ping.mjs', ['--feeds', `${srv.origin}/feed.xml,${srv.origin}/rss-nohub.xml,${srv.origin}/sitemap.xml`]);
  await sample('indexing-submitter.json', 'indexing-submitter.mjs', ['--dry-run', '--urls', ['/jobs/acme-engineer', '/live/acme-launch', '/blog/plain'].map((p) => srv.origin + p).join(',')]);

  // AI citation tracker: mocked API responses (fictional). Shows cited, not cited and an error record.
  const answers = {
    'what does acme build': { citations: ['https://www.example.com/blog/foo-bar-post', 'https://widgets.example.org/acme'] },
    'best widget vendors for startups': { citations: ['https://widgets.example.org/top-10', 'https://notexample.com/widgets'] },
  };
  const fetchImpl = async (_url, opts) => {
    const prompt = JSON.parse(opts.body).messages[0].content;
    const body = answers[prompt];
    return body
      ? { ok: true, status: 200, text: async () => JSON.stringify({ model: 'sonar', ...body }) }
      : { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limit exceeded' } }) };
  };
  const prompts = readFileSync(new URL('./prompts.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const report = await runTracker({ prompts, domain: 'example.com', providers: ['perplexity'], models: { perplexity: 'sonar' }, keys: { perplexity: 'mock' }, delayMs: 0, fetchImpl });
  writeFileSync(join(ROOT, 'samples', 'ai-citations.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('samples/ai-citations.json');
} finally {
  await srv.close();
}
