# -*- coding: utf-8 -*-
"""
STEP 04 - Converts data/pop_coverage_map.gpkg -> output/population_coverage.geojson (EPSG:4326).
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out, riepilogo = P.data, P.out, P.riepilogo
import geopandas as gpd

src = data("pop_coverage_map.gpkg")
dst = out("population_coverage.geojson")

print("STEP 04 · population_coverage conversion")
gdf = gpd.read_file(src)
print("CRS in:", gdf.crs, "| n_feat:", len(gdf), "| geom:", gdf.geom_type.unique().tolist())
if gdf.crs is None:
    print("Missing CRS, assuming EPSG:3857.")
    gdf.set_crs(3857, inplace=True)
if str(gdf.crs).upper() not in ("EPSG:4326",):
    gdf = gdf.to_crs(4326)
for col in gdf.columns:
    if col == "geometry":
        continue
    try:
        gdf[col] = gdf[col].where(gdf[col].notna(), None)
    except Exception:
        pass
if os.path.exists(dst):
    os.remove(dst)
gdf.to_file(dst, driver="GeoJSON")

with open(dst, "r", encoding="utf-8") as f:
    gj = json.load(f)
riepilogo(features=len(gj.get("features", [])), kb=round(os.path.getsize(dst)/1024, 1))
print("OK -> output/population_coverage.geojson")
