#!/usr/bin/env bash
# Build every tile of one city: CITY=<id> tools/nyc/build_city.sh [jobs]   (ids: tools/nyc/cities.json; docs/cities.md)
# Stages: extract (OSM -> derived/*.ndjson, skipped when present unless FRESH=1), mask, ground, buildings, props, index + route.
set -euo pipefail
cd "$(dirname "$0")"
JOBS="${1:-3}"
CITY="${CITY:-nyc}"; export CITY
DATA=$(python3 -c 'import tilelib; print(tilelib.DERIVED)')
if [ "${FRESH:-0}" = 1 ] || [ ! -f "$DATA/roads.ndjson" ]; then
  echo "== $CITY: extract"; python3 extract.py
fi
echo "== $CITY: mask"; python3 mask.py
echo "== $CITY: ground"; python3 ground.py --all --jobs "$JOBS" --meshopt
echo "== $CITY: buildings"; python3 buildings.py --all --jobs "$JOBS"
echo "== $CITY: props"; python3 props.py --all --jobs "$JOBS" | tail -3
echo "== $CITY: index + route"; python3 build_index.py
echo "== $CITY: done"
