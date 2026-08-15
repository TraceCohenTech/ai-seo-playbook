#!/bin/bash

# Vercel Ignore Build Step
#
# Controls when Vercel actually runs a build vs. skipping it.
# Without this, every git push triggers a full build — and if you
# have automated content pipelines pushing multiple times a day,
# your Vercel bill explodes.
#
# Place this file at the root of your project and set it as the
# "Ignored Build Step" in Vercel Project Settings → Git.
#
# How it works:
#   - Commits with [nobuild] in the message → skip the build
#   - Content-only changes (markdown, JSON) → skip (handled by ISR)
#   - Code changes (tsx, ts, css, config) → build
#   - Scheduled deploy-tick commits → build (catches accumulated content)
#
# Combined with a deploy-tick cron (e.g., 4x/day), this pattern lets
# you push content continuously without paying for continuous builds.
#
# WARNING: Vercel's ignoreCommand has a 256-char limit. This script
# stays under that by keeping the logic simple.

COMMIT_MSG=$(git log -1 --format='%s')

# [nobuild] tag = explicit skip
if echo "$COMMIT_MSG" | grep -q '\[nobuild\]'; then
  echo "🔕 Skipping build ([nobuild] tag)"
  exit 0  # 0 = don't build
fi

# deploy-tick = always build (this is the scheduled catchup)
if echo "$COMMIT_MSG" | grep -q '\[deploy-tick\]'; then
  echo "🔨 Building (deploy-tick)"
  exit 1  # 1 = build
fi

# Check if only content files changed
CHANGED=$(git diff HEAD~1 --name-only 2>/dev/null || echo "FORCE_BUILD")

# If we can't diff (shallow clone, first commit), always build
if [ "$CHANGED" = "FORCE_BUILD" ]; then
  echo "🔨 Building (can't determine changes)"
  exit 1
fi

# Content-only changes don't need a rebuild (ISR handles them)
NEEDS_BUILD=$(echo "$CHANGED" | grep -v -E '\.(md|mdx|json|txt|csv)$' | grep -v -E '^_posts/' | head -1)

if [ -z "$NEEDS_BUILD" ]; then
  echo "🔕 Skipping build (content-only changes, ISR will handle)"
  exit 0
fi

echo "🔨 Building (code changes detected)"
exit 1
