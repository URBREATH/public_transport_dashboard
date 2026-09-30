# -*- coding: utf-8 -*-
"""
STEP 03.2 - Mosaics the GHS-POP 2025 tiles, clips on Leuven and produces a PNG.

Steps:
 1. Opens the GHS-POP E2025 tiles (3 arcsec, WGS84 / EPSG:4326) from data/popolazione/ghsl/.
 2. Mosaics them (merge).
 3. Clips on the Leuven bounding box (from the LAU lau_eurostat.gpkg) + margin.
 4. Saves a clipped GeoTIFF (data/popolazione/ghsl/) and a PNG (output/).
"""
import os, sys, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out = P.data, P.out
import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.mask import mask
from rasterio.warp import transform_bounds
import geopandas as gpd
from shapely.geometry import box
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, PowerNorm

GHSL = data("popolazione", "ghsl")
os.makedirs(GHSL, exist_ok=True)
OUT_TIF = os.path.join(GHSL, "pop_2025_mollweide.tif")   # input of step 03.3 (historical name kept)
OUT_PNG = out("population_2025.png")                     # final preview

# NB (Luca's change): the source data is now GHS-POP 3 arcsec in WGS84 (EPSG:4326).
# Mollweide is no longer forced: the clip happens in the NATIVE CRS of the tiles.

print("STEP 03.2 · Mosaic + clip GHS-POP on the city")

# 1) open tiles
tifs = sorted(glob.glob(os.path.join(GHSL, "GHS_POP_E2025_*_R*_C*.tif")))
print("Tiles:", [os.path.basename(t) for t in tifs])
srcs = [rasterio.open(t) for t in tifs]
print("Tiles CRS:", srcs[0].crs)

# 2) mosaic
mosaic, out_trans = merge(srcs)
print("Mosaic shape:", mosaic.shape)
meta = srcs[0].meta.copy()
meta.update({"height": mosaic.shape[1], "width": mosaic.shape[2],
             "transform": out_trans, "count": 1})

# 3) Leuven bbox from the LAU (lau_eurostat.gpkg) -> NATIVE CRS of the raster, with margin
DST_CRS = srcs[0].crs   # native CRS of the tiles (now EPSG:4326)
_lau_gpkg = data("lau_eurostat.gpkg")
_lau_src = _lau_gpkg if os.path.exists(_lau_gpkg) else data("transport_15min.geojson")
print("Boundary (bbox) from:", os.path.basename(_lau_src))
lau = gpd.read_file(_lau_src).dissolve()
b3857 = lau.to_crs(3857).total_bounds
margin = 1500  # 1.5 km
minx, miny, maxx, maxy = transform_bounds(3857, DST_CRS,
        b3857[0]-margin, b3857[1]-margin, b3857[2]+margin, b3857[3]+margin)
clip_geom = [box(minx, miny, maxx, maxy)]
print("Clip bbox (native CRS", DST_CRS, "):", [round(v, 4) for v in (minx, miny, maxx, maxy)])

tmp = os.path.join(GHSL, "_mosaic_tmp.tif")
with rasterio.open(tmp, "w", **meta) as dst:
    dst.write(mosaic[0], 1)
with rasterio.open(tmp) as src:
    clipped, clip_trans = mask(src, clip_geom, crop=True)
    cmeta = src.meta.copy()

arr = clipped[0].astype("float32")
nod = meta.get("nodata", None)
if nod is not None:
    arr[arr == nod] = np.nan
arr[arr < 0] = np.nan

cmeta.update({"height": arr.shape[0], "width": arr.shape[1],
              "transform": clip_trans, "dtype": "float32",
              "count": 1, "nodata": np.nan})
with rasterio.open(OUT_TIF, "w", **cmeta) as dst:
    dst.write(arr, 1)
print("Clipped GeoTIFF:", OUT_TIF, "shape:", arr.shape)

valid = arr[np.isfinite(arr)]
print("Valid cells:", valid.size, "| total pop ~", int(np.nansum(valid)),
      "| max cell:", round(float(np.nanmax(valid)), 1) if valid.size else 0)

# 4) colored PNG
colors = ["#f7fbff", "#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026", "#67000d"]
cmap = LinearSegmentedColormap.from_list("pop", colors)
cmap.set_bad(alpha=0.0)
vmax = max(np.nanpercentile(valid, 99.5) if valid.size else 1, 1)
norm = PowerNorm(gamma=0.45, vmin=0, vmax=vmax)

h, w = arr.shape
fig_w = 10
fig_h = fig_w * h / w
fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=150)
im = ax.imshow(np.ma.masked_invalid(arr), cmap=cmap, norm=norm, interpolation="nearest")
ax.set_axis_off()
ax.set_title("GHS-POP 2025 Population (3 arcsec, WGS84)", fontsize=12, pad=8)
cbar = fig.colorbar(im, ax=ax, fraction=0.035, pad=0.02)
cbar.set_label("Inhabitants per cell (~90x90 m, 3 arcsec)", fontsize=9)
fig.tight_layout()
fig.savefig(OUT_PNG, dpi=150, bbox_inches="tight", facecolor="white", transparent=False)
print("PNG saved:", OUT_PNG, os.path.getsize(OUT_PNG), "bytes")

for s in srcs:
    s.close()
try:
    os.remove(tmp)
except Exception:
    pass
print("OK -> data/popolazione/ghsl/pop_2025_mollweide.tif + output/population_2025.png")
