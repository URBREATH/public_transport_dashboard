# -*- coding: utf-8 -*-
"""
CLIP GHS-POP 2025 using ONLY lau_eurostat.gpkg (exact polygon outline),
in a SINGLE pass, starting from the WHOLE tile downloaded by 03_1.

Does NOT use transport_15min.geojson. Does NOT use the bounding box alone: it clips on the
REAL GEOMETRY (dissolve) of the Eurostat LAU boundary.

Input : data/popolazione/ghsl/GHS_POP_E2025_*_R*_C*.tif   (whole tiles)
        data/lau_eurostat.gpkg                            (cutting outline)
Output: data/popolazione/ghsl/pop_2025_clip_lau.tif       (clipped GeoTIFF)
"""
import os, sys, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data = P.data
import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.mask import mask
import geopandas as gpd

GHSL = data("popolazione", "ghsl")
OUT_TIF = os.path.join(GHSL, "pop_2025_clip_lau.tif")

print("CLIP GHS-POP 2025 · ONLY lau_eurostat.gpkg (exact outline)")

# 1) whole tiles downloaded by 03_1
tifs = sorted(glob.glob(os.path.join(GHSL, "GHS_POP_E2025_*_R*_C*.tif")))
if not tifs:
    print("ERROR: no GHS_POP_E2025_*_R*_C*.tif tile in", GHSL,
          "-> run 03_1_ghsl_download.py first")
    sys.exit(1)
print("Whole tiles found:", [os.path.basename(t) for t in tifs])

srcs = [rasterio.open(t) for t in tifs]
print("Tiles CRS:", srcs[0].crs)
SRC_CRS = srcs[0].crs   # native CRS of the tiles (now EPSG:4326)

# 2) mosaic (if multiple tiles); if only one it stays identical
mosaic, out_trans = merge(srcs)
meta = srcs[0].meta.copy()
meta.update({"height": mosaic.shape[1], "width": mosaic.shape[2],
             "transform": out_trans, "count": 1})
tmp = os.path.join(GHSL, "_mosaic_lau_tmp.tif")
with rasterio.open(tmp, "w", **meta) as dst:
    dst.write(mosaic[0], 1)
for s in srcs:
    s.close()

# 3) Eurostat LAU boundary -> Mollweide, REAL GEOMETRY (dissolve), NOT bbox
lau_gpkg = data("lau_eurostat.gpkg")
if not os.path.exists(lau_gpkg):
    print("ERROR: lau_eurostat.gpkg not found in", os.path.dirname(lau_gpkg))
    sys.exit(1)
lau = gpd.read_file(lau_gpkg).dissolve()
lau["geometry"] = lau.buffer(0)          # repair any invalid geometries
area_km2 = round(lau.to_crs(3035).area.iloc[0] / 1e6, 2)
print("LAU boundary: 1 polygon, area km2 =", area_km2)
lau_moll = lau.to_crs(SRC_CRS)
geom_moll = [g.__geo_interface__ for g in lau_moll.geometry]

# 4) EXACT clip on the LAU outline
with rasterio.open(tmp) as src:
    clipped, ctrans = mask(src, geom_moll, crop=True, nodata=np.nan, filled=True)
    cmeta = src.meta.copy()
    h, w = clipped.shape[1], clipped.shape[2]

arr = clipped[0].astype("float32")
arr[arr < 0] = np.nan
cmeta.update({"height": h, "width": w, "transform": ctrans,
              "dtype": "float32", "nodata": np.nan, "count": 1})
with rasterio.open(OUT_TIF, "w", **cmeta) as dst:
    dst.write(arr, 1)

valid = arr[np.isfinite(arr) & (arr > 0)]
pop_tot = int(np.nansum(arr[np.isfinite(arr)]))
print(f"Clipped GeoTIFF: {OUT_TIF}  shape: {h}x{w}")
print(f"Cells pop>0: {valid.size} | total pop inside LAU ~ {pop_tot} "
      f"| max cell: {round(float(np.nanmax(valid)),1) if valid.size else 0}")

try:
    os.remove(tmp)
except Exception:
    pass
print("OK -> data/popolazione/ghsl/pop_2025_clip_lau.tif")
