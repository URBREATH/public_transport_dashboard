# -*- coding: utf-8 -*-

import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
out, riepilogo = P.out, P.riepilogo
import geopandas as gpd
import pandas as pd

# OFFICIAL SOURCE: data_separati/line.gpkg (same place as stop.gpkg).
DATA_SEP = os.path.abspath(os.path.join(P.ROOT_DIR, "data"))
src = os.path.join(DATA_SEP, "line.gpkg")
dst = out("line.geojson")

# Geographic layers to merge; 'layer_styles' (QGIS style) must be excluded.
MODI = ["bus", "metro", "tram"]

print("STEP 02_2 - Line conversion from the OFFICIAL SOURCE data_separati/line.gpkg")
if not os.path.exists(src):
    print(f"ERROR: missing {src} (expected data_separati/line.gpkg).")
    sys.exit(1)

parti = []
for modo in MODI:
    try:
        g = gpd.read_file(src, layer=modo)
    except Exception as e:
        print(f"  [WARN] layer '{modo}' not read from line.gpkg: {e}")
        continue
    if g.crs is None:
        print(f"  Missing CRS on '{modo}', assuming EPSG:4326.")
        g.set_crs(4326, inplace=True)
    if str(g.crs).upper() not in ("EPSG:4326",):
        g = g.to_crs(4326)
    print(f"  layer '{modo}': n_feat={len(g)} | geom={g.geom_type.unique().tolist()}")
    parti.append(g)

if not parti:
    print("ERROR: no readable bus/metro/tram layer in line.gpkg.")
    sys.exit(1)

gdf = gpd.GeoDataFrame(pd.concat(parti, ignore_index=True), crs="EPSG:4326")
print("Total merged lines:", len(gdf))

# NaN -> None (valid JSON, no non-standard 'NaN' in the GeoJSON)
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
print("OK -> output/line.geojson")
