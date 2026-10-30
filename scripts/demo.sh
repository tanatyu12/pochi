#!/bin/sh
# Records docs/demo.gif from docs/demo.tape in Docker. The dry run in it calls Claude through the
# API, so set ANTHROPIC_API_KEY; GITHUB_TOKEN keeps GitHub's rate limit away.
set -eu
# Without it the dry run in the demo only says that no LLM is available.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "demo: set ANTHROPIC_API_KEY; the container cannot use this machine's claude or codex login" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
npm run build
docker build -q -t pochi-demo docs/demo >/dev/null
docker run --rm -v "$PWD:/vhs" -e ANTHROPIC_API_KEY -e GITHUB_TOKEN pochi-demo docs/demo.tape
