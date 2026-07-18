"""Shared helpers for the Steradian Land Prospector data pipeline."""
import json
import math
import os
import time
import urllib.parse
import urllib.request

RAW = "data/raw"
os.makedirs(RAW, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

# Texas bounding box (generous)
TX_BBOX = (-107.0, 25.4, -93.2, 36.8)

# Coverage corridor: TX + LA/MS/AR (Baton Rouge–Memphis) + AZ
CORRIDOR_BBOX = (-115.0, 25.4, -88.7, 37.05)
STATES = ("TX", "LA", "MS", "AR", "AZ")
STATE_NAMES = {"Texas": "TX", "Louisiana": "LA", "Mississippi": "MS",
               "Arkansas": "AR", "Arizona": "AZ"}
COUNTY_FIPS_PREFIXES = ("48", "22", "28", "05", "04")


def http_json(url, params=None, retries=3, timeout=90):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"failed after {retries} tries: {url}: {last}")


def http_bytes(url, retries=3, timeout=180):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"failed after {retries} tries: {url}: {last}")


def arcgis_query_all(layer_url, where="1=1", out_fields="*", geometry_bbox=None,
                     geojson=True, page_size=1000):
    """Page through an ArcGIS FeatureServer layer, returning all features."""
    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": out_fields,
            "returnGeometry": "true",
            "outSR": 4326,
            "f": "geojson" if geojson else "json",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }
        if geometry_bbox:
            params.update({
                "geometry": ",".join(str(v) for v in geometry_bbox),
                "geometryType": "esriGeometryEnvelope",
                "inSR": 4326,
                "spatialRel": "esriSpatialRelIntersects",
            })
        d = http_json(layer_url + "/query", params)
        if "error" in d:
            raise RuntimeError(f"arcgis error: {d['error']}")
        batch = d.get("features", [])
        features.extend(batch)
        print(f"  ... {len(features)} features", flush=True)
        if len(batch) < page_size:
            break
        offset += page_size
    return features


def save_geojson(path, features):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"wrote {path}: {len(features)} features")


def save_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    n = len(obj) if isinstance(obj, (list, dict)) else "?"
    print(f"wrote {path} ({n} items)")


def load_json(path):
    with open(path) as f:
        return json.load(f)


def haversine_mi(lon1, lat1, lon2, lat2):
    r = 3958.761
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
