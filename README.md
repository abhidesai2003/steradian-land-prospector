# Steradian Land Prospector

A **living** prospecting tool for powered land in Texas — 5 MW-and-up sites with power and
fiber that are (or may soon be) for sale. Public grid, queue, fiber, and listing data are
combined into one scored, explorable map that **updates itself**.

## How it stays live

| Loop | Cadence | What it does |
|---|---|---|
| `refresh-data` GitHub Action | every 6 h | Re-pulls HIFLD grid, latest ERCOT GIS Report, PeeringDB; rebuilds all scores; commits `web/data` if anything changed |
| `deploy-pages` GitHub Action | on every push | Redeploys the dashboard to GitHub Pages |
| Deal-hunting Claude routine | daily | Hunts the web for new Texas powered-land listings & market signals, verifies sources, updates `pipeline/listings_curated.json`, pushes |
| In-page watcher | every 5 min | Open tabs poll `summary.json` and hot-reload when new data lands |

## Local development

```bash
./run.sh            # serve the dashboard → http://localhost:8123
./run.sh refresh    # re-download all live datasets, rebuild scores, then serve
```

## What's inside

**Map layers**
| Layer | Source | What it tells you |
|---|---|---|
| Transmission lines (100–500 kV, color/width by voltage) | HIFLD Open | Where wholesale power physically runs |
| Substations (in-service, sized by kV) | HIFLD snapshot 2025-01 | Interconnection points; each gets an opportunity score |
| County heat | ERCOT GIS Report | Queued MW by county — where the market is moving |
| ERCOT queue (≥5 MW projects, county-level positions) | ERCOT GIS Report (monthly) | Generation & battery pipeline = future co-location power |
| Power plants (≥10 MW, sized by MW) | EIA-860 | Existing generation for behind-the-meter deals |
| Fiber / colo facilities | PeeringDB (live API) | Network density; long-haul proximity proxy |
| **For-sale powered land** (gold, pulsing) + market signals (hollow) | Compiled from broker pages & press | The actual deal flow |

**Scoring** — every listed site and every substation gets a 0–100 composite:
- **Power** (42%): nearest substation kV & distance, 345 kV / 100 kV+ line distance, stated capacity
- **Fiber** (23%): distance to nearest colo, network count, stated fiber
- **Scale** (15%): acreage (log-scaled) or stated MW
- **Momentum** (20%): county queue MW, active-listing status, development activity

Click any site or substation for a full dossier: proximity metrics computed from raw grid
geometry, score breakdown, broker contact, source link, and a diligence checklist.

## Architecture

```
pipeline/
  common.py             ArcGIS REST paging, HTTP, haversine helpers
  fetch_grid.py         counties + transmission lines + substations + power plants
  fetch_ercot.py        latest monthly GIS Report from ERCOT MIS → queue JSON
  fetch_fiber.py        PeeringDB facilities + TX internet exchanges
  listings_curated.json for-sale sites & market signals (agent-maintained, sourced)
  build.py              enrichment + scoring → web/data/*.geojson
web/                    the dashboard (vanilla JS + MapLibre GL, no build step)
.github/workflows/      the self-refresh + deploy loops
```

## Adding a listing

Append to `pipeline/listings_curated.json` (coords precision: `exact`/`city`/`county`/`region`,
always include `source`), run `python pipeline/build.py`, push. The daily routine does this
automatically for anything it can verify from public sources.

## Caveats

- **Queue positions are county-level.** ERCOT publishes county + POI name, not coordinates;
  dots are jittered within the county, with the POI string in the tooltip.
- **ERCOT Large Load (data-center) queue is confidential** at site level; county heat and
  market signals are the public proxies for demand.
- **Verify before underwriting.** HIFLD voltages can be inferred; substation headroom
  requires TSP confirmation; "powered" claims in listings are the broker's.
