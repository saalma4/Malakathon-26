#!/usr/bin/env bash
# Opens a real game and runs the checker live, step by step.
#   ./play.sh              Bubble Up on betsson.es, play for fun (log in once: .env or by hand)
#   ./play.sh demo         Pragmatic Play public demo (Sweet Bonanza), no login
#   ./play.sh <url> [--market=es] [--game=sweet-bonanza] [--spins=3] [--headless]
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
npx playwright install chromium >/dev/null
exec npx tsx scripts/play-fun.ts "$@"
