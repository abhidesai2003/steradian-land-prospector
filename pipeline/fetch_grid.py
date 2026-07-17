"""Fetch Texas grid infrastructure: transmission lines, substations, power plants.

Sources (all public ArcGIS FeatureServer REST endpoints):
- Transmission lines: HIFLD Open (DHS) — voltage, owner, status per segment
- Substations: HIFLD snapshot 2025-01-09 (community mirror of the retired open layer)
- Power plants: EIA-860 derived national layer (Federal User Community)
"""
import json
import sys

sys.path.insert(0, "pipeline")
from common import RAW, TX_BBOX, arcgis_query_all, http_bytes, save_geojson

LINES_URL = ("https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/"
             "Electric_Power_Transmission_Lines/FeatureServer/0")
SUBS_URL = ("https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/"
            "Substations/FeatureServer/0")
PLANTS_URL = ("https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
              "Power_Plants_in_the_US/FeatureServer/0")


COUNTIES_URL = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"


def fetch_counties():
    """US counties GeoJSON filtered to Texas (FIPS 48)."""
    d = json.loads(http_bytes(COUNTIES_URL))
    tx = [f for f in d["features"] if f["id"].startswith("48")]
    save_geojson(f"{RAW}/tx_counties.geojson", tx)


def main():
    print("== County boundaries (TX) ==", flush=True)
    fetch_counties()

    print("== Substations (TX) ==", flush=True)
    subs = arcgis_query_all(SUBS_URL, where="STATE='TX'")
    save_geojson(f"{RAW}/substations_tx.geojson", subs)

    print("== Power plants (TX) ==", flush=True)
    plants = arcgis_query_all(PLANTS_URL, where="State='Texas'")
    save_geojson(f"{RAW}/power_plants_tx.geojson", plants)

    print("== Transmission lines (TX bbox) ==", flush=True)
    lines = arcgis_query_all(LINES_URL, geometry_bbox=TX_BBOX, page_size=2000)
    save_geojson(f"{RAW}/transmission_lines_tx.geojson", lines)


if __name__ == "__main__":
    main()
