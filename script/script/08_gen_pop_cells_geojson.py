# -*- coding: utf-8 -*-

import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out, progress = P.data, P.out, P.progress
import numpy as np
import rasterio
from shapely.geometry import box, mapping
from shapely.ops import transform as shp_transform
import pyproj

TIF = data("popolazione", "ghsl", "pop_2025_clip_exact.tif")
OUT = out("pop_2025_cells.geojson")

print("STEP 03.4 · Population cells -> clickable GeoJSON")

with rasterio.open(TIF) as src:
    arr = src.read(1)
    tr = src.transform
    crs = src.crs
    h, w = arr.shape

to_wgs = pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform

feats = []
tot = 0.0
# progress bar over the raster rows: "processed r/h"
for r in progress(range(h), total=h, desc="cells (rows)", unit="row"):
    for c in range(w):
        v = arr[r, c]
        if not np.isfinite(v) or v <= 0:
            continue
        pop = round(float(v))
        if pop <= 0:
            continue
        x0, y0 = tr * (c, r)
        x1, y1 = tr * (c + 1, r + 1)
        cell = box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        cell_wgs = shp_transform(to_wgs, cell)
        feats.append({
            "type": "Feature",
            "properties": {"pop": pop},
            "geometry": mapping(cell_wgs),
        })
        tot += pop

fc = {"type": "FeatureCollection",
      "name": "pop_2025_cells",
      "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
      "features": feats}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(fc, f)

pops = [ft["properties"]["pop"] for ft in feats]
print("Cells written:", len(feats))
print("Total pop (sum of tiles):", int(tot))
if pops:
    print("pop min/max per cell:", min(pops), "/", max(pops))
print("OK ->", OUT, "|", round(os.path.getsize(OUT) / 1024, 1), "KB")
