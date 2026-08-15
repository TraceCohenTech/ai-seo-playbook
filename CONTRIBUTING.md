# Contributing to AI SEO Playbook

Thanks for your interest in improving the toolkit. Here's how to contribute.

## Ways to Contribute

### Add Template Phrase Patterns

The blocklist in `config/anti-ai-rules.json` is never complete — LLMs keep inventing new template phrases. If you've found patterns we're missing:

1. Add the phrase to the appropriate category (`hedging`, `templateOpeners`, `templateClosers`, `filler`, `metaCommentary`)
2. Test it against your own content to make sure it doesn't false-positive on legitimate writing
3. Submit a PR with examples of the phrase in the wild

### Improve Scoring Heuristics

The content audit scorer in `scripts/content-audit.mjs` and the rewrite candidate scorer in `scripts/gsc-rewrite-candidates.mjs` use hand-tuned thresholds. If you've found better values:

1. Show your data — what site, how many pages, what the old score produced vs. your improvement
2. Explain why the new threshold works better
3. Keep defaults conservative (false negatives are better than false positives for a diagnostic tool)

### Add Schema Examples

If you've implemented structured data that drives rich results and want to share the pattern, add it to `/schemas` with:

- A complete, valid JSON-LD example
- A `notes` array explaining implementation details
- Any gotchas you discovered

### Submit Sample Outputs

Running the scripts on your own site? Anonymize the data and submit sample outputs to `/samples`. More examples help new users understand what to expect.

## Development

```bash
git clone https://github.com/TraceCohenTech/ai-seo-playbook.git
cd ai-seo-playbook
npm install

# Run any script
node scripts/template-detector.mjs --dir ./your-content
```

The scripts are standalone `.mjs` files with no build step. Edit and run.

## Pull Request Process

1. Fork the repo
2. Create a branch (`git checkout -b add-template-phrases`)
3. Make your changes
4. Test against real content if possible
5. Submit a PR with a clear description of what changed and why

## Code Style

- Scripts are ES modules (`.mjs`)
- Use `parseArgs` from `node:util` for CLI arguments
- Keep scripts standalone — no shared utility files
- Console output should be human-readable (not just JSON dumps)
- JSON output via `--output` flag for automation

## Questions?

Open an issue or reach out to [Trace Cohen](https://x.com/Trace_Cohen).
