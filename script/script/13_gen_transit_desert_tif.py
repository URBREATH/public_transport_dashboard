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
from rasterio.transform import from_origin
from rasterio.features import rasterize
from rasterio.warp import calculate_default_transform, reproject, Resampling

NODATA = -1.0
WGS84 = "EPSG:4326"

# Desert threshold identical to step 13 / plugin: desert cell if pct_covered < 10 AND pop > 0.
SOGLIA_DESERTO_PCT = 10.0

# Bands, in order. Band 1 = pop_uncovered (used by the frontend for coloring).
BANDS = ["pop_uncovered", "pop", "pct_covered"]


def utm_crs_for(gdf_wgs84):
    c = gdf_wgs84.geometry.union_all().centroid
    lon, lat = c.x, c.y
    zone = int(math.floor((lon + 180.0) / 6.0) + 1)
    return f"EPSG:{32600 + zone if lat >= 0 else 32700 + zone}"


def stima_lato_cella_m(gdf_utm):
    b = gdf_utm.geometry.head(2000).bounds
    larg = (b["maxx"] - b["minx"]).replace(0, np.nan)
    alt = (b["maxy"] - b["miny"]).replace(0, np.nan)
    lato = float(np.nanmedian(np.concatenate([larg.values, alt.values])))
    if not math.isfinite(lato) or lato <= 0:
        return 100.0
    return lato


def _rasterizza_su_griglia(gdf_wgs84, crs, transform, width, height):
    """Rasterizes the bands directly on the given WGS84 grid (the coverage tif one)."""
    g = gdf_wgs84.to_crs(crs)
    bands = []
    for col in BANDS:
        shapes = ((geom, val) for geom, val in zip(g.geometry, g[col]))
        arr = rasterize(
            shapes=shapes,
            out_shape=(height, width),
            transform=transform,
            fill=NODATA,
            all_touched=False,
            dtype="float32",
        )
        bands.append(arr)
    return np.stack(bands, axis=0).astype("float32")


def main():
    cov_tif = out("pop_coverage_map.tif")
    dst = out("transit_desert.tif")

    print("STEP 05.5b . Rasterizing Transit desert ALIGNED to pop_coverage_map.tif")

    if not os.path.exists(cov_tif):
        print("ERROR: missing output/pop_coverage_map.tif (run step 10 first).")
        sys.exit(1)

    if os.path.exists(cov_tif):
        with rasterio.open(cov_tif) as ref:
            ref_crs = ref.crs
            ref_transform = ref.transform
            ref_w, ref_h = ref.width, ref.height
            cov_pct = ref.read(1).astype("float32")   # pct_covered
            cov_pop = ref.read(2).astype("float32")   # pop_tot
            cov_unc = ref.read(4).astype("float32")   # pop_uncovered
        print(f"  reference grid READ from pop_coverage_map.tif: "
              f"{ref_w} x {ref_h} px | crs {ref_crs}")
        print(f"  DERIVING the desert from the coverage PIXELS (no vector rasterization)")

        # pixels where the coverage EXISTS (not nodata on pct_covered)
        cov_valido = cov_pct != NODATA
        # desert rule: coverage exists AND pct_covered < threshold AND pop > 0
        deserto_mask = cov_valido & (cov_pct < SOGLIA_DESERTO_PCT) & (cov_pop > 0)

        # output bands, all NODATA except where there is desert
        b_unc = np.full((ref_h, ref_w), NODATA, dtype="float32")
        b_pop = np.full((ref_h, ref_w), NODATA, dtype="float32")
        b_pct = np.full((ref_h, ref_w), NODATA, dtype="float32")
        b_unc[deserto_mask] = cov_unc[deserto_mask]
        b_pop[deserto_mask] = cov_pop[deserto_mask]
        b_pct[deserto_mask] = cov_pct[deserto_mask]
        data = np.stack([b_unc, b_pop, b_pct], axis=0).astype("float32")

        n_valid = int(deserto_mask.sum())
        pop = float(cov_pop[deserto_mask].sum()) if n_valid else 0.0
        unc = float(cov_unc[deserto_mask].sum()) if n_valid else 0.0
        # safety check: no desert pixel outside the coverage
        orfani = int((deserto_mask & (~cov_valido)).sum())
        print(f"  desert pixels: {n_valid} | pop in deserts: {int(pop)} | unserved: {int(unc)}")
        print(f"  desert pixels WITHOUT coverage underneath: {orfani} (must be 0)")

        prof = {
            "driver": "GTiff", "height": ref_h, "width": ref_w, "count": len(BANDS),
            "dtype": "float32", "crs": ref_crs, "transform": ref_transform, "nodata": NODATA,
            "compress": "deflate", "predictor": 3, "zlevel": 9,
            "tiled": True, "blockxsize": 256, "blockysize": 256,
        }
        if os.path.exists(dst):
            os.remove(dst)
        with rasterio.open(dst, "w", **prof) as ds:
            ds.write(data)
            for b in range(1, len(BANDS) + 1):
                ds.set_band_description(b, BANDS[b - 1])

        kb = os.path.getsize(dst) / 1024.0
        print(f"  GeoTIFF WGS84 written: {ref_w} x {ref_h} px | {kb:.1f} KB")
        riepilogo(bande=len(BANDS), width=ref_w, height=ref_h,
                  pixel_deserto=n_valid, pixel_orfani=orfani, kb=round(kb, 1),
                  griglia="DERIVED from the pixels of pop_coverage_map.tif (total overlap)")
        print("OK -> output/transit_desert.tif (derived from the coverage pixels, total overlap)")
        return



if __name__ == "__main__":
    main()
