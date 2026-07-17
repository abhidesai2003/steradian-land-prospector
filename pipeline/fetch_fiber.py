"""Fetch connectivity data for Texas.

- PeeringDB facilities (colo/data centers) in TX: location + network/carrier/IX counts.
  Facilities with high carrier counts anchor metro fiber density; long-haul routes
  follow highway/rail rights-of-way between them.
- PeeringDB internet exchanges in TX metros.
"""
import sys

sys.path.insert(0, "pipeline")
from common import RAW, http_json, save_json


def main():
    print("== PeeringDB facilities (TX) ==", flush=True)
    d = http_json("https://www.peeringdb.com/api/fac", {"state": "TX", "limit": 500})
    facs = [
        {
            "id": f["id"], "name": f["name"], "org": f["org_name"],
            "city": f["city"], "zip": f.get("zipcode"),
            "lat": f["latitude"], "lon": f["longitude"],
            "net_count": f.get("net_count", 0),
            "ix_count": f.get("ix_count", 0),
            "carrier_count": f.get("carrier_count", 0),
        }
        for f in d["data"] if f.get("latitude") and f.get("longitude")
    ]
    save_json(f"{RAW}/peeringdb_fac_tx.json", facs)

    print("== PeeringDB IXs (TX) ==", flush=True)
    tx_cities = {f["city"].lower() for f in facs if f.get("city")}
    d = http_json("https://www.peeringdb.com/api/ix", {"country": "US", "limit": 1500})
    ixs = [
        {
            "id": x["id"], "name": x["name"], "city": x["city"],
            "net_count": x.get("net_count", 0),
        }
        for x in d["data"]
        if x.get("city") and x["city"].lower() in tx_cities
    ]
    save_json(f"{RAW}/peeringdb_ix_tx.json", ixs)


if __name__ == "__main__":
    main()
