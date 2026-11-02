#!/bin/sh
# Runs the playground and docs dev servers together; Ctrl-C stops both. Usage: dev.sh
# In dev the docs frame the playground at localhost:5173 (docs/site-urls.mjs), so the playground has to get exactly
# that port: it fails instead of moving to another one when something else holds it.
cd "$(dirname "$0")/.." || exit 1

if pid=$(lsof -tiTCP:5173 -sTCP:LISTEN); then
  echo "dev.sh: port 5173 is taken (pid $pid: $(ps -o comm= -p "$pid")); stop it first" >&2
  exit 1
fi

# Both servers run in this script's process group; stopping it stops them. Without a terminal `astro dev` detaches
# into a background server of its own, which only `astro dev stop` ends.
trap 'trap - INT TERM EXIT; (cd docs && bunx astro dev stop >/dev/null 2>&1); kill 0' INT TERM EXIT
(cd playground && bun run dev --strictPort) &
(cd docs && bun run dev) &
echo "playground: http://localhost:5173/   configurator: http://localhost:5173/configure"
echo "docs:       http://localhost:4321/   configurator: http://localhost:4321/guides/configurator/"
wait
