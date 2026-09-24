#!/bin/bash
# Vercel "Ignored Build Step": skip builds for data/content-only commits and build for everything else.
# Set Project Settings → Git → Ignored Build Step to:  bash examples/vercel-ignore.sh
# Exit 0 = SKIP the build, exit 1 = BUILD.
#
# Lessons baked in (both cost us real deploys):
#   1. Diff against the LAST DEPLOYED commit ($VERCEL_GIT_PREVIOUS_SHA), not HEAD~1. A push that holds
#      a code commit followed by a [nobuild] data commit otherwise skips the code.
#   2. Build-time generators are code even if they live in scripts/. Our blanket "scripts/ is not site code"
#      rule silently skipped a merged data-quality fix. List your prebuild generators in BUILD_PATHS.
#   3. package.json / tsconfig.json / vercel.json are code, not "content JSON".
#   4. With ISR, content that is BUNDLED in the repo is only picked up by a new build. "Skip, ISR will
#      handle it" is only true for content fetched at request time.

PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"
MSG=$(git log -1 --format=%s)

# Always build when we can't diff against the last deploy (first deploy, shallow clone, force push).
if [ -z "$PREV" ] || ! git cat-file -e "$PREV" 2>/dev/null; then echo "build: no previous deploy to diff"; exit 1; fi

# Paths whose change always requires a build (edit for your repo).
BUILD_PATHS="src app pages components lib public next.config.* package.json package-lock.json tsconfig.json vercel.json scripts/build scripts/generate-*"

if git diff --quiet "$PREV" HEAD -- $BUILD_PATHS 2>/dev/null; then
  echo "skip: no code/build-input changes since $PREV ($MSG)"; exit 0
fi
case "$MSG" in *"[nobuild]"*)
  # A [nobuild] tag only skips when nothing in BUILD_PATHS changed since the last deploy (checked above).
  ;;
esac
echo "build: code or build inputs changed since $PREV"; exit 1
