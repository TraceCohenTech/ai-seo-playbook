# 6. Running an AI content engine safely and cheaply

Lessons from running ~15 cron jobs, several cloud AI routines and CI on one site.

## Shared-checkout hygiene
- Jobs that commit from one working tree need a **repo-wide lock**, not just a per-job lock. Two jobs
  pulling at the same minute once left raw merge-conflict markers in generated JSON.
- Jobs that rebuild data leave build by-products modified; the next `git pull --autostash` conflicts
  with CI commits touching the same files. On exit, restore by-products, but **only paths that were
  clean when the job started**, so you never discard someone's in-progress work.
- Tests that regenerate tracked files belong in a disposable worktree, not the live checkout.

## Deploy cost control
- Tag data-only commits (e.g. `[nobuild]`) and skip their builds in the host's "ignored build step".
- But treat **build-time generators as code**. Our skip rule excluded everything under `scripts/`,
  where the prebuild generators live, so fixes to them never deployed on their own.
- Never build a filesystem path from a variable in serverless code: the bundler's file tracer
  includes the whole repo in every function (we hit ~240 MB). Use literal paths.
- Read only the one index file a route needs; importing a shared loader traced ~19 MB of JSON into a
  sitemap function.

## AI routines
- Put the model where it adds judgment (rewriting, research), and keep everything else deterministic:
  selection, validation, measurement, dedupe, sitemaps.
- Cloud sandboxes may not be able to fetch your own site (ours got 403s). Render assets somewhere
  that can, commit them, and let the AI step only publish.
- Detect usage-limit failures explicitly ("hit your weekly limit"). Otherwise they get treated as
  network errors and retried into junk commits.
- Budget by edits, not runs: fewer, measured, higher-leverage changes beat daily churn.
