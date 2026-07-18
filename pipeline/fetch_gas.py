"""Fetch natural gas transmission pipelines (EIA) for the coverage corridor.

The sourcing playbook starts from the pipe: the investable universe is land near
high-pressure gas transmission with available capacity (TGP, Transco, Texas Gas
Transmission, Gulf South, Energy Transfer, Kinder Morgan, ...).
"""
import sys

sys.path.insert(0, "pipeline")
from common import RAW, CORRIDOR_BBOX, arcgis_query_all, save_geojson

GAS_URL = ("https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/"
           "Natural_Gas_Interstate_and_Intrastate_Pipelines_1/FeatureServer/0")


def main():
    print("== Natural gas pipelines (corridor bbox) ==", flush=True)
    feats = arcgis_query_all(GAS_URL, geometry_bbox=CORRIDOR_BBOX,
                             out_fields="TYPEPIPE,Operator,Status", page_size=2000)
    save_geojson(f"{RAW}/gas_pipelines.geojson", feats)


if __name__ == "__main__":
    main()
