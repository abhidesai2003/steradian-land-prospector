#!/bin/bash
# Steradian Land Prospector — refresh data and serve the dashboard.
#   ./run.sh            serve the dashboard at http://localhost:8123
#   ./run.sh refresh    re-download all public datasets, rebuild scores, then serve
set -e
cd "$(dirname "$0")"

PY=.venv/bin/python
if [ ! -x "$PY" ]; then
  echo "Creating venv..."
  python3 -m venv .venv
  .venv/bin/pip install -q openpyxl requests
fi

if [ "$1" = "refresh" ]; then
  echo "== Fetching grid infrastructure (HIFLD/EIA) =="
  $PY pipeline/fetch_grid.py
  echo "== Fetching ERCOT interconnection queue =="
  $PY pipeline/fetch_ercot.py
  echo "== Fetching fiber/colo data (PeeringDB) =="
  $PY pipeline/fetch_fiber.py
  echo "== Fetching gas pipelines (EIA) =="
  $PY pipeline/fetch_gas.py
  echo "== Rebuilding scores and web data =="
  $PY pipeline/build.py
elif [ ! -f web/data/summary.json ]; then
  echo "No built data found — running build..."
  $PY pipeline/build.py
fi

echo
echo "Steradian Land Prospector → http://localhost:8123"
echo "   (Ctrl-C to stop)"
cd web && python3 -m http.server 8123
