# -*- coding: utf-8 -*-

import os
import sys
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
out, riepilogo = P.out, P.riepilogo

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.features import rasterize

NODATA = -1.0
WGS84 = "EPSG:4326"

BANDS = ["pct_covered", "pop_tot", "pop_covered", "pop_uncovered"]

GRID_REF = P.data("popolazione", "ghsl", "pop_2025_clip_exact.tif")


def main():
    src = out("population_coverage.geojson")
    dst = out("pop_coverage_map.tif")

    print("STEP 05.5 . Rasterizing Population coverage on the NATIVE GHSL grid (4 bands)")

    if not os.path.exists(src):
        print("ERROR: missing output/population_coverage.geojson (run 04 and 05b first).")
        sys.exit(1)
    if not os.path.exists(GRID_REF):
        print(f"ERROR: missing reference grid {GRID_REF} (run step 05 first).")
        sys.exit(1)

    gdf = gpd.read_file(src)
    if gdf.crs is None:
        gdf.set_crs(WGS84, inplace=True)
    gdf = gdf.to_crs(WGS84)

    # normalize the fields (missing -> 0; pop_tot fallback to 'pop')
    for col in BANDS:
        if col not in gdf.columns:
            if col == "pop_tot" and "pop" in gdf.columns:
                gdf["pop_tot"] = gdf["pop"]
            else:
                print(f"  WARNING: field '{col}' missing, filling with 0.")
                gdf[col] = 0.0
        gdf[col] = gdf[col].astype(float).fillna(0.0)

    # --- NATIVE GHSL grid read from clip_exact (pixel-perfect alignment) ---
    with rasterio.open(GRID_REF) as ref:
        ref_transform = ref.transform
        ref_crs = ref.crs
        width = ref.width
        height = ref.height
    print(f"  cells: {len(gdf)} | native GHSL grid: {width} x {height} px | CRS: {ref_crs}")
    print(f"  transform: {ref_transform.a:.8f} (lon step) | origin: ({ref_transform.c:.6f}, {ref_transform.f:.6f})")

    # if the geojson is not already in the grid's native EPSG:4326, align it to the ref CRS
    if str(gdf.crs).upper() != str(ref_crs).upper():
        gdf = gdf.to_crs(ref_crs)

    # --- rasterize each band DIRECTLY on the native grid (no UTM, no reprojection) ---
    bands = []
    for col in BANDS:
        shapes = ((geom, val) for geom, val in zip(gdf.geometry, gdf[col]))
        arr = rasterize(
            shapes=shapes,
            out_shape=(height, width),
            transform=ref_transform,
            fill=NODATA,
            all_touched=False,      # cell -> pixel whose center is inside (no smearing)
            dtype="float32",
        )
        bands.append(arr)
    data_grid = np.stack(bands, axis=0).astype("float32")

    valid = data_grid[0] != NODATA
    n_valid = int(valid.sum())
    pop_tot = float(np.where(valid, data_grid[1], 0).sum())
    pop_cov = float(np.where(valid, data_grid[2], 0).sum())
    pop_unc = float(np.where(valid, data_grid[3], 0).sum())
    print(f"  valid pixels: {n_valid} | pop_tot: {int(pop_tot)} | covered: {int(pop_cov)} | uncovered: {int(pop_unc)}")

    # --- write the GeoTIFF on the SAME grid as clip_exact (guaranteed alignment) ---
    prof = {
        "driver": "GTiff", "height": height, "width": width, "count": len(BANDS),
        "dtype": "float32", "crs": ref_crs, "transform": ref_transform, "nodata": NODATA,
        "compress": "deflate", "predictor": 3, "zlevel": 9,
        "tiled": True, "blockxsize": 256, "blockysize": 256,
    }
    if os.path.exists(dst):
        os.remove(dst)
    with rasterio.open(dst, "w", **prof) as dstds:
        dstds.write(data_grid)
        for b in range(1, len(BANDS) + 1):
            dstds.set_band_description(b, BANDS[b - 1])

    kb = os.path.getsize(dst) / 1024.0
    print(f"  GeoTIFF WGS84 (native GHSL grid): {width} x {height} px | {kb:.1f} KB")

    riepilogo(bande=len(BANDS), crs=str(ref_crs), width=int(width), height=int(height),
              pixel_validi=n_valid, kb=round(kb, 1))
    print("OK -> output/pop_coverage_map.tif (4 bands, pixel-perfect aligned to clip_exact)")


if __name__ == "__main__":
    main()
