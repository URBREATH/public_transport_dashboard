# -*- coding: utf-8 -*-
"""
STEP 03.3 - GHS-POP 2025 population PNG layer clipped EXACTLY on the Leuven
boundary (dissolve of transport_15min.geojson). Transparent background outside
the boundary, ready as a Leaflet imageOverlay.

Output:
 - output/pop_2025_layer.png    (transparent RGBA, for the assets)
 - output/pop_2025_layer.json   (bounds/meta)
 - data/popolazione/ghsl/pop_2025_clip_exact.tif  (clip GeoTIFF, intermediate)
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out = P.data, P.out
import numpy as np
import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_bounds
from rasterio.transform import array_bounds
import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
from matplotlib.colors import LinearSegmentedColormap, PowerNorm
from PIL import Image

GHSL = data("popolazione", "ghsl")
SRC_TIF = os.path.join(GHSL, "pop_2025_mollweide.tif")
OUT_PNG = out("pop_2025_layer.png")
OUT_META = out("pop_2025_layer.json")
OUT_TIF = os.path.join(GHSL, "pop_2025_clip_exact.tif")
# Luca's change: source now 3 arcsec WGS84; the NATIVE CRS of the raster is used.

print("STEP 03.3 · Exact clip on the boundary + PNG overlay")

gj = gpd.read_file(data("lau_eurostat.gpkg"))
boundary = gj.dissolve()
boundary["geometry"] = boundary.buffer(0)
print("Leuven boundary: 1 polygon, area km2 =",
      round(boundary.to_crs(3035).area.iloc[0] / 1e6, 2))
# native CRS of the source raster (now EPSG:4326)
with rasterio.open(SRC_TIF) as _s:
    SRC_CRS = _s.crs
boundary_src = boundary.to_crs(SRC_CRS)
geom_moll = [g.__geo_interface__ for g in boundary_src.geometry]

# 2) exact clip
with rasterio.open(SRC_TIF) as src:
    clipped, ctrans = mask(src, geom_moll, crop=True, nodata=np.nan, filled=True, all_touched=True)
    cmeta = src.meta.copy()
    h, w = clipped.shape[1], clipped.shape[2]
    b = array_bounds(h, w, ctrans)

arr = clipped[0].astype("float32")
arr[arr < 0] = np.nan
cmeta.update({"height": h, "width": w, "transform": ctrans,
              "dtype": "float32", "nodata": np.nan, "count": 1})
with rasterio.open(OUT_TIF, "w", **cmeta) as dst:
    dst.write(arr, 1)

valid = arr[np.isfinite(arr) & (arr > 0)]
pop_tot = int(np.nansum(arr[np.isfinite(arr)]))
print(f"Cells pop>0: {valid.size} | total pop inside Leuven ~ {pop_tot} "
      f"| max cell: {round(float(np.nanmax(valid)),1) if valid.size else 0}")

# 3) transparent RGBA rendering
colors = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026", "#67000d"]
cmap = LinearSegmentedColormap.from_list("pop", colors)
vmax = max(np.nanpercentile(valid, 99.5), 1) if valid.size else 1
norm = PowerNorm(gamma=0.45, vmin=0, vmax=vmax)
rgba = cmap(norm(np.nan_to_num(arr, nan=0.0)))
visible = np.isfinite(arr) & (arr > 0)
rgba[..., 3] = np.where(visible, 1.0, 0.0)
Image.fromarray((rgba * 255).astype(np.uint8), mode="RGBA").save(OUT_PNG)
print("PNG:", OUT_PNG, os.path.getsize(OUT_PNG), "bytes |", w, "x", h, "px")

# 4) meta/bounds
wgs = transform_bounds(SRC_CRS, 4326, b[0], b[1], b[2], b[3])
merc = transform_bounds(SRC_CRS, 3857, b[0], b[1], b[2], b[3])
meta = {
    "product": "GHS_POP_E2025_R2023A_4326_3ss",
    "clip": "official Leuven boundary (dissolve transport_15min.geojson)",
    "png": "assets/pop_2025_layer.png",
    "width_px": w, "height_px": h,
    "bounds_wgs84": {"west": wgs[0], "south": wgs[1], "east": wgs[2], "north": wgs[3]},
    "bounds_webmercator": {"minx": merc[0], "miny": merc[1], "maxx": merc[2], "maxy": merc[3]},
    "leaflet_imageOverlay_bounds": [[wgs[1], wgs[0]], [wgs[3], wgs[2]]],
    "pop_total": pop_tot, "vmax": float(vmax), "gamma": 0.45, "colormap": colors,
}
with open(OUT_META, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)
print("Bounds Leaflet [[S,W],[N,E]]:", meta["leaflet_imageOverlay_bounds"])
print("OK -> output/pop_2025_layer.png + .json")
