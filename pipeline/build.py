"""Enrich, score, and package all raw datasets into web-ready files.

Outputs to web/data/:
  lines.geojson       transmission lines (decimated, tagged by kV class)
  substations.geojson in-service substations w/ opportunity scores
  plants.geojson      power plants >= 10 MW
  queue.geojson       ERCOT interconnection queue (county-centroid located)
  fiber.geojson       PeeringDB colo/data-center facilities
  listings.geojson    curated for-sale sites + market signals, fully enriched
  counties.geojson    county polygons w/ rollups (queue MW, HV subs, plants MW)
  summary.json        headline stats for the dashboard
"""
import datetime
import hashlib
import json
import math
import sys

sys.path.insert(0, "pipeline")
from common import RAW, STATE_NAMES, haversine_mi, load_json

FIPS_STATE = {"48": "TX", "22": "LA", "28": "MS", "05": "AR", "04": "AZ",
              "35": "NM", "40": "OK"}

WEB = "web/data"

# First-seen registry: stamps when each listing / queue project first appeared,
# so the UI can flag newly added locations. Entries from the tracker's launch
# baseline are never flagged.
FIRST_SEEN_PATH = "pipeline/first_seen.json"
BASELINE = "2026-07-16"
NEW_LISTING_DAYS = 14
NEW_QUEUE_DAYS = 35

VOLT_CLASS_NOMINAL = {"100-161": 138, "220-287": 230, "345": 345, "500": 500}

FUEL_NAMES = {"SOL": "Solar", "WIN": "Wind", "GAS": "Gas", "NUC": "Nuclear",
              "OIL": "Oil", "HYD": "Hydro", "WAT": "Hydro", "COA": "Coal"}


# ---------------------------------------------------------------- geometry --

def ring_centroid(ring):
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    return lon, lat


def poly_centroid(geom):
    if geom["type"] == "Polygon":
        return ring_centroid(geom["coordinates"][0])
    rings = [p[0] for p in geom["coordinates"]]
    biggest = max(rings, key=len)
    return ring_centroid(biggest)


def pt_seg_dist_mi(px, py, ax, ay, bx, by):
    """Distance point->segment in miles, equirectangular approx around p."""
    kx = math.cos(math.radians(py)) * 69.172
    ky = 68.972
    ax, bx, px2 = (ax - px) * kx, (bx - px) * kx, 0.0
    ay, by, py2 = (ay - py) * ky, (by - py) * ky, 0.0
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(ax, ay)
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


def line_coords(geom):
    if geom["type"] == "LineString":
        yield geom["coordinates"]
    elif geom["type"] == "MultiLineString":
        yield from geom["coordinates"]


def dist_to_line_mi(lon, lat, feature, cutoff=1e9):
    """Min distance from point to a line feature, with cheap bbox rejection."""
    best = 1e9
    for coords in line_coords(feature["geometry"]):
        # bbox reject
        xs = [c[0] for c in coords]; ys = [c[1] for c in coords]
        ddeg = cutoff / 55.0  # conservative deg per mile
        if lon < min(xs) - ddeg or lon > max(xs) + ddeg or lat < min(ys) - ddeg or lat > max(ys) + ddeg:
            continue
        for i in range(len(coords) - 1):
            d = pt_seg_dist_mi(lon, lat, coords[i][0], coords[i][1],
                               coords[i + 1][0], coords[i + 1][1])
            if d < best:
                best = d
    return best


def decimate(coords, min_deg=0.002):
    out = [coords[0]]
    for c in coords[1:-1]:
        lc = out[-1]
        if abs(c[0] - lc[0]) + abs(c[1] - lc[1]) >= min_deg:
            out.append(c)
    out.append(coords[-1])
    return [[round(c[0], 4), round(c[1], 4)] for c in out]


def jitter(key, scale=0.13):
    h = int(hashlib.md5(key.encode()).hexdigest(), 16)
    ang = (h % 360) * math.pi / 180
    rad = ((h >> 16) % 1000) / 1000 * scale + 0.02
    return math.cos(ang) * rad, math.sin(ang) * rad * 0.85


# ------------------------------------------------------------------ loaders --

def load_all():
    d = {}
    d["subs"] = load_json(f"{RAW}/substations_tx.geojson")["features"]
    d["lines"] = load_json(f"{RAW}/transmission_lines_tx.geojson")["features"]
    d["plants"] = load_json(f"{RAW}/power_plants_tx.geojson")["features"]
    d["queue"] = load_json(f"{RAW}/ercot_queue.json")
    d["fiber"] = load_json(f"{RAW}/peeringdb_fac_tx.json")
    d["gas"] = load_json(f"{RAW}/gas_pipelines.geojson")["features"]
    d["ix"] = load_json(f"{RAW}/peeringdb_ix_tx.json")
    d["counties"] = load_json(f"{RAW}/tx_counties.geojson")["features"]
    d["curated"] = load_json("pipeline/listings_curated.json")
    return d


# ------------------------------------------------------------------ scoring --

def est_mw_class(kv):
    if kv is None:
        return "unknown"
    if kv >= 345:
        return "300+ MW"
    if kv >= 230:
        return "100–300 MW"
    if kv >= 138:
        return "50–150 MW"
    if kv >= 115:
        return "25–75 MW"
    if kv >= 69:
        return "5–25 MW"
    return "< 5 MW"


def volt_points(kv):
    if kv is None:
        return 8
    for thresh, pts in [(500, 40), (345, 40), (230, 32), (138, 26), (115, 20), (69, 12)]:
        if kv >= thresh:
            return pts
    return 5


def prox_score(dist_mi, full_at, zero_at, max_pts):
    """max_pts when closer than full_at, linear decay to 0 at zero_at."""
    if dist_mi is None:
        return 0
    if dist_mi <= full_at:
        return max_pts
    if dist_mi >= zero_at:
        return 0
    return max_pts * (zero_at - dist_mi) / (zero_at - full_at)


# --------------------------------------------------------------------- main --

def main():
    d = load_all()

    try:
        first_seen = load_json(FIRST_SEEN_PATH)
    except FileNotFoundError:
        first_seen = {}
    today = datetime.date.today()

    def mark(kind, key):
        """Record first sighting; return (date_first_seen, age_days)."""
        k = f"{kind}:{key}"
        if k not in first_seen:
            first_seen[k] = today.isoformat()
        seen = first_seen[k]
        return seen, (today - datetime.date.fromisoformat(seen)).days

    # counties keyed by FIPS (avoids cross-state name collisions), with a
    # per-state name lookup for sources that only give county names
    county = {}
    name_fips = {}
    for f in d["counties"]:
        p = f["properties"]
        fips = p["STATE"] + p["COUNTY"]
        st = FIPS_STATE[p["STATE"]]
        lon, lat = poly_centroid(f["geometry"])
        county[fips] = {"name": p["NAME"], "st": st, "lon": lon, "lat": lat, "fips": fips,
                        "queue_mw": 0.0, "queue_n": 0, "queue_solar": 0.0, "queue_wind": 0.0,
                        "queue_gas": 0.0, "queue_battery": 0.0, "hv_subs": 0, "plants_mw": 0.0,
                        "listings": 0}
        name_fips[(st, p["NAME"].lower())] = fips

    # ---- substations (in service, deduped) ----
    subs = []
    for f in d["subs"]:
        p = f["properties"]
        if p.get("STATUS") == "NOT AVAILABLE":
            continue
        kv = p.get("MAX_VOLT")
        kv = None if not kv or kv <= 0 else float(kv)
        lon, lat = p["LONGITUDE"], p["LATITUDE"]
        name = p.get("NAME") or ""
        subs.append({
            "name": ("" if name.startswith("UNKNOWN") else name.title()),
            "lon": lon, "lat": lat, "kv": kv,
            "min_kv": (None if not p.get("MIN_VOLT") or p["MIN_VOLT"] <= 0 else p["MIN_VOLT"]),
            "lines": p.get("LINES") or 0,
            "county": (p.get("COUNTY") or "").lower(),
            "st": p.get("STATE"),
            "cfips": p.get("COUNTYFIPS"),
            "status": p.get("STATUS"),
        })
        c = county.get(p.get("COUNTYFIPS"))
        if c is not None and kv and kv >= 138:
            c["hv_subs"] += 1

    # ---- plants ----
    plants = []
    for f in d["plants"]:
        p = f["properties"]
        mw = p.get("Total_MW") or 0
        if mw < 10:
            continue
        st = STATE_NAMES.get(p.get("State"), "TX")
        plants.append({
            "name": p.get("Plant_Name"), "mw": mw,
            "fuel": p.get("PrimSource"), "tech": p.get("tech_desc"),
            "county": (p.get("County") or "").lower(), "st": st,
            "lon": p.get("Longitude"), "lat": p.get("Latitude"),
        })
        c = county.get(name_fips.get((st, (p.get("County") or "").lower())))
        if c is not None:
            c["plants_mw"] += mw

    # ---- ERCOT queue ----
    queue = []
    for pr in d["queue"]["projects"]:
        mw = pr.get("mw") or 0
        if mw < 5:
            continue
        tech = (pr.get("tech") or "").upper()
        fuel = (pr.get("fuel") or "").upper()
        if tech in ("BA", "ES") or (fuel == "OTH" and "BATT" in (pr.get("name") or "").upper()):
            cat = "Battery"
        else:
            cat = FUEL_NAMES.get(fuel, "Other")
        cnames = [c.strip().lower() for c in (pr.get("county") or "").replace("/", ",").split(",") if c.strip()]
        c0 = next((name_fips[("TX", c)] for c in cnames if ("TX", c) in name_fips), None)
        since, age = mark("queue", pr["inr"])
        item = {
            "inr": pr["inr"], "name": pr["name"], "mw": mw, "cat": cat,
            "fuel": fuel, "tech": tech, "county": pr.get("county"),
            "zone": pr.get("zone"), "cod": pr.get("cod"), "phase": pr.get("phase"),
            "poi": pr.get("poi"),
            "new": since > BASELINE and age <= NEW_QUEUE_DAYS,
        }
        if c0:
            dx, dy = jitter(pr["inr"])
            item["lon"] = county[c0]["lon"] + dx
            item["lat"] = county[c0]["lat"] + dy
            cc = county[c0]
            cc["queue_mw"] += mw
            cc["queue_n"] += 1
            key = {"Solar": "queue_solar", "Wind": "queue_wind", "Gas": "queue_gas",
                   "Battery": "queue_battery"}.get(cat)
            if key:
                cc[key] += mw
        queue.append(item)

    # ---- fiber ----
    fiber = d["fiber"]
    metro_nets = {}
    for x in d["ix"]:
        metro_nets[x["city"].lower()] = metro_nets.get(x["city"].lower(), 0) + x["net_count"]

    gas_lines = d["gas"]

    # ---- 345kV line list for distance checks ----
    lines345 = [f for f in d["lines"] if VOLT_CLASS_NOMINAL.get(f["properties"].get("VOLT_CLASS"), 0) >= 345]
    lines_all = d["lines"]

    def nearest(pts, lon, lat, key=lambda o: (o["lon"], o["lat"])):
        best, bd = None, 1e9
        for o in pts:
            ox, oy = key(o)
            if ox is None:
                continue
            dd = haversine_mi(lon, lat, ox, oy)
            if dd < bd:
                bd, best = dd, o
        return best, bd

    def nearest_line_mi(feats, lon, lat):
        best = 1e9
        for f in feats:
            best = min(best, dist_to_line_mi(lon, lat, f, cutoff=best))
        return best

    # county activity: 0..1 blend usable in every state (ERCOT queue exists
    # only in TX, so take the max of queue, installed-gen, and HV-sub density)
    for c in county.values():
        c["activity"] = min(1.0, max(c["queue_mw"] / 3000,
                                     c["plants_mw"] / 8000,
                                     c["hv_subs"] / 40))

    # ---- substation opportunity scores ----
    print("scoring substations...", flush=True)
    hv_subs = [s for s in subs if (s["kv"] or 0) >= 69 or s["kv"] is None]
    for s in subs:
        _, fd = nearest(fiber, s["lon"], s["lat"])
        pn, pd = nearest(plants, s["lon"], s["lat"])
        near_plant_mw = sum(p["mw"] for p in plants
                            if abs(p["lon"] - s["lon"]) < 0.25 and abs(p["lat"] - s["lat"]) < 0.2
                            and haversine_mi(s["lon"], s["lat"], p["lon"], p["lat"]) <= 10)
        cc = county.get(s["cfips"], {})
        cq = cc.get("queue_mw", 0)
        score = (volt_points(s["kv"])
                 + min(s["lines"], 8) / 8 * 15
                 + prox_score(fd, 1, 120, 15)
                 + min(near_plant_mw / 1000, 1) * 15
                 + cc.get("activity", 0) * 15)
        s["fiber_mi"] = round(fd, 1)
        s["near_plant_mw"] = round(near_plant_mw)
        s["county_queue_mw"] = round(cq)
        s["est_mw"] = est_mw_class(s["kv"])
        s["score"] = round(score)

    # ---- listings enrichment ----
    print("scoring listings...", flush=True)
    listings = []
    for L in d["curated"]["sites"]:
        lon, lat = L["lon"], L["lat"]
        cands = [s for s in hv_subs if s["kv"] and s["kv"] >= 100]
        ns, nsd = nearest(cands, lon, lat)
        d345 = nearest_line_mi(lines345, lon, lat)
        dall = nearest_line_mi(lines_all, lon, lat)
        nf, nfd = nearest(fiber, lon, lat)
        np_, npd = nearest([p for p in plants if p["mw"] >= 100], lon, lat)
        dgas = nearest_line_mi(gas_lines, lon, lat)
        gas_op = None
        if dgas < 1e8:
            best = 1e9
            for g in gas_lines:
                dd = dist_to_line_mi(lon, lat, g, cutoff=best)
                if dd < best:
                    best, gas_op = dd, (g["properties"].get("Operator") or None)
        lst = L.get("state", "TX")
        cfs = [name_fips[(lst, c)] for c in
               (c.strip().lower().split("(")[0].strip()
                for c in (L.get("county") or "").replace("/", ",").split(","))
               if (lst, c) in name_fips]
        cq = sum(county[c]["queue_mw"] for c in cfs)
        if cfs:
            county[cfs[0]]["listings"] += 1

        stated = 20 if L.get("power_mw") else (10 if L.get("power_notes") else 0)
        power = min(100, volt_points(ns["kv"] if ns else None)
                    + prox_score(nsd, 2, 30, 20)
                    + prox_score(d345, 1, 25, 20)
                    + prox_score(dall, 0.5, 15, 10)
                    + prox_score(dgas, 1.5, 25, 12)
                    + stated)
        fiber_sc = min(100, prox_score(nfd, 5, 150, 55)
                       + (25 if L.get("fiber_notes") else 0)
                       + min((nf or {}).get("net_count", 0), 100) / 100 * 20)
        acres = L.get("acres")
        if acres:
            scale = min(100, math.log10(max(acres, 10)) / math.log10(5000) * 100)
        elif L.get("power_mw"):
            scale = min(100, L["power_mw"] / 10)
        else:
            scale = 40
        cact = max((county[c]["activity"] for c in cfs), default=0)
        momentum = min(100, max(min(cq / 4000, 1), cact) * 60
                       + (25 if L["kind"] == "signal" else 0)
                       + (15 if "construction" in (L.get("status") or "").lower()
                          or "development" in (L.get("status") or "").lower() else 0))
        if L["kind"] == "listing":
            momentum = min(100, momentum + 25)
        overall = round(0.42 * power + 0.23 * fiber_sc + 0.15 * scale + 0.20 * momentum)

        added, age = mark("listing", L["id"])
        E = dict(L)
        E.update({
            "added": added,
            "is_new": added > BASELINE and age <= NEW_LISTING_DAYS,
            "nearest_sub": (ns["name"] or "Unnamed") if ns else None,
            "nearest_sub_kv": ns["kv"] if ns else None,
            "nearest_sub_mi": round(nsd, 1) if ns else None,
            "d345_mi": round(d345, 1) if d345 < 1e8 else None,
            "dline_mi": round(dall, 1) if dall < 1e8 else None,
            "fiber_fac": nf["name"] if nf else None,
            "fiber_mi": round(nfd, 1) if nf else None,
            "fiber_nets": (nf or {}).get("net_count"),
            "gas_mi": round(dgas, 1) if dgas < 1e8 else None,
            "gas_op": gas_op,
            "state": lst,
            "plant100": np_["name"] if np_ else None,
            "plant100_mw": (np_ or {}).get("mw"),
            "plant100_mi": round(npd, 1) if np_ else None,
            "county_queue_mw": round(cq),
            "score_power": round(power), "score_fiber": round(fiber_sc),
            "score_scale": round(scale), "score_momentum": round(momentum),
            "score": overall,
        })
        listings.append(E)

    # ------------------------------------------------------------- outputs --
    def fc(feats):
        return {"type": "FeatureCollection", "features": feats}

    def w(path, obj):
        with open(f"{WEB}/{path}", "w") as f:
            json.dump(obj, f)
        print(f"wrote {WEB}/{path}")

    # lines (decimated)
    lf = []
    for f in d["lines"]:
        p = f["properties"]
        vc = VOLT_CLASS_NOMINAL.get(p.get("VOLT_CLASS"), 0)
        geom = f["geometry"]
        if geom["type"] == "LineString":
            ng = {"type": "LineString", "coordinates": decimate(geom["coordinates"])}
        else:
            ng = {"type": "MultiLineString",
                  "coordinates": [decimate(c) for c in geom["coordinates"]]}
        owner = p.get("OWNER")
        lf.append({"type": "Feature", "geometry": ng, "properties": {
            "kv": p.get("VOLTAGE") if (p.get("VOLTAGE") or 0) > 0 else None,
            "vc": vc, "owner": None if owner == "NOT AVAILABLE" else owner}})
    w("lines.geojson", fc(lf))

    sf = [{"type": "Feature",
           "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
           "properties": {k: s[k] for k in ("name", "kv", "min_kv", "lines", "county", "status",
                                            "fiber_mi", "near_plant_mw", "county_queue_mw",
                                            "est_mw", "score")}}
          for s in subs]
    w("substations.geojson", fc(sf))

    pf = [{"type": "Feature",
           "geometry": {"type": "Point", "coordinates": [round(p["lon"], 5), round(p["lat"], 5)]},
           "properties": {k: p[k] for k in ("name", "mw", "fuel", "tech", "county")}}
          for p in plants]
    w("plants.geojson", fc(pf))

    qf = [{"type": "Feature",
           "geometry": {"type": "Point", "coordinates": [round(q["lon"], 5), round(q["lat"], 5)]},
           "properties": {k: q[k] for k in ("inr", "name", "mw", "cat", "county", "zone",
                                            "cod", "phase", "poi", "new")}}
          for q in queue if "lon" in q]
    w("queue.geojson", fc(qf))

    ff = [{"type": "Feature",
           "geometry": {"type": "Point", "coordinates": [round(x["lon"], 5), round(x["lat"], 5)]},
           "properties": {k: x[k] for k in ("name", "org", "city", "net_count", "ix_count",
                                            "carrier_count")}}
          for x in fiber]
    w("fiber.geojson", fc(ff))

    Lf = [{"type": "Feature",
           "geometry": {"type": "Point", "coordinates": [L["lon"], L["lat"]]},
           "properties": {k: v for k, v in L.items() if k not in ("lon", "lat")}}
          for L in listings]
    w("listings.geojson", fc(Lf))

    gf = []
    for f in d["gas"]:
        p = f["properties"]
        geom = f["geometry"]
        if not geom:
            continue
        if geom["type"] == "LineString":
            ng = {"type": "LineString", "coordinates": decimate(geom["coordinates"], 0.004)}
        else:
            ng = {"type": "MultiLineString",
                  "coordinates": [decimate(c, 0.004) for c in geom["coordinates"]]}
        gf.append({"type": "Feature", "geometry": ng, "properties": {
            "op": p.get("Operator"), "t": p.get("TYPEPIPE")}})
    w("pipelines.geojson", fc(gf))

    cf = []
    for f in d["counties"]:
        p = f["properties"]
        c = county[p["STATE"] + p["COUNTY"]]
        cf.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "name": c["name"], "st": c["st"], "fips": c["fips"],
            "heat": round(c["activity"] * 100),
            "queue_mw": round(c["queue_mw"]), "queue_n": c["queue_n"],
            "queue_solar": round(c["queue_solar"]), "queue_wind": round(c["queue_wind"]),
            "queue_gas": round(c["queue_gas"]), "queue_battery": round(c["queue_battery"]),
            "hv_subs": c["hv_subs"], "plants_mw": round(c["plants_mw"]),
            "listings": c["listings"]}})
    w("counties.geojson", fc(cf))

    top_counties = sorted(county.values(), key=lambda v: -v["queue_mw"])[:15]
    summary = {
        "generated": datetime.date.today().isoformat(),
        "states": ["TX", "LA", "MS", "AR", "AZ", "NM", "OK"],
        "gas_miles": round(sum(
            haversine_mi(a[0], a[1], b[0], b[1])
            for f in d["gas"] if f.get("geometry")
            for coords in line_coords(f["geometry"])
            for a, b in zip(coords, coords[1:]))),
        "gis_report": d["queue"].get("report"),
        "listings_total": sum(1 for L in listings if L["kind"] == "listing"),
        "signals_total": sum(1 for L in listings if L["kind"] == "signal"),
        "listed_acres": round(sum(L.get("acres") or 0 for L in listings if L["kind"] == "listing")),
        "listed_mw": round(sum(L.get("power_mw") or 0 for L in listings if L["kind"] == "listing")),
        "subs_total": len(subs),
        "subs_345": sum(1 for s in subs if (s["kv"] or 0) >= 345),
        "subs_138": sum(1 for s in subs if 138 <= (s["kv"] or 0) < 345),
        "lines_mi_345": round(sum(f["properties"]["SHAPE__Len"] for f in d["lines"]
                                  if VOLT_CLASS_NOMINAL.get(f["properties"].get("VOLT_CLASS"), 0) >= 345) / 1609),
        "queue_projects": len(queue),
        "queue_mw": round(sum(q["mw"] for q in queue)),
        "queue_by_cat": {},
        "queue_near_term_mw": round(sum(q["mw"] for q in queue if (q.get("cod") or "9999") <= "2027-12-31")),
        "new_sites": sum(1 for L in listings if L["is_new"]),
        "new_queue_n": sum(1 for q in queue if q["new"]),
        "fiber_facilities": len(fiber),
        "ix_total": len(d["ix"]),
        "plants_mw": round(sum(p["mw"] for p in plants)),
        "top_counties": [{"name": v["name"], "st": v["st"], **{x: round(v[x]) for x in
                          ("queue_mw", "queue_solar", "queue_wind", "queue_gas", "queue_battery")},
                          "queue_n": v["queue_n"], "hv_subs": v["hv_subs"]}
                         for v in top_counties],
    }
    for q in queue:
        summary["queue_by_cat"][q["cat"]] = round(summary["queue_by_cat"].get(q["cat"], 0) + q["mw"])
    w("summary.json", summary)

    with open(FIRST_SEEN_PATH, "w") as f:
        json.dump(first_seen, f, indent=0, sort_keys=True)
    print(f"first-seen registry: {len(first_seen)} entries")


if __name__ == "__main__":
    main()
