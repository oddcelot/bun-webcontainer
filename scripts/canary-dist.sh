#!/usr/bin/env bash
# Marks a canary build (dist-canary/ of the playground or the docs) as not for search engines, before
# `wrangler deploy --env canary`. Usage: scripts/canary-dist.sh <dist dir>
# - X-Robots-Tag: noindex on every response (_headers). This is the signal that keeps pages out of results.
# - A robots.txt that allows crawling: a crawler that may not fetch a page never sees its noindex, and a blocked URL
#   can still be listed from links to it. No Sitemap line.
# - No sitemaps: they would list canary URLs (and the playground's names runbun.dev).
set -euo pipefail
dir=${1:?usage: canary-dist.sh <dist dir>}
[ -d "$dir" ] || { echo "canary-dist: no $dir" >&2; exit 1; }
printf '\n# Canary: never indexed (scripts/canary-dist.sh)\n/*\n  X-Robots-Tag: noindex\n' >> "$dir/_headers"
printf '# Canary build: not for search engines (every response is noindex).\nUser-agent: *\nAllow: /\n' > "$dir/robots.txt"
rm -f "$dir"/sitemap*.xml
echo "canary-dist: $dir marked noindex"
