# -*- coding: utf-8 -*-
"""
=============================================================================
STEP 5b - CLIP THE RASTER HEATMAPS ON THE CITY BOUNDARY (lau_eurostat)
=============================================================================

The raster heatmaps produced by STEP 5 (heatmap_bus.tif, heatmap_metro.tif,
heatmap_tram.tif, heatmap_unione.tif + the *_reds.tif previews) have as their
extent the bounding box of the transport LINES: they therefore spill OUTSIDE
the municipality. This step CLIPS (masks) them on the administrative boundary
of the city taken from data/lau_eurostat.gpkg (the SAME boundary used by the
rest of the pipeline, via _common: C.CONFINE_GPKG + C.CONFINE_LAYER).

WHAT IT DOES
------------
For each heatmap_*.tif present in output/:
  1. reads the raster and the city boundary;
  2. reprojects the boundary into the raster CRS;
  3. applies rasterio.mask (crop=False -> keeps the same grid/extent,
     sets to nodata everything that is OUTSIDE the boundary);
  4. overwrites the .tif with the clipped version (same structure, same
     number of bands, same dtype).

By doing so STEP 6 (deploy) - which reads from output/ - will publish into the
dashboard assets the ALREADY CLIPPED heatmaps, without needing to touch anything else.

POSITION IN THE PIPELINE
------------------------
It must be run AFTER step 5 (which generates the .tif) and BEFORE step 6 (deploy):
    5_generate_mode_heatmaps.py  ->  5b_clip_heatmaps_to_boundary.py  ->  6_deploy_heatmap_assets.py
This way, from now on, EVERY pipeline run automatically clips
the heatmaps on the boundary before publishing them.
=============================================================================
"""

import os
import glob

import geopandas as gpd
import rasterio
from rasterio.mask import mask as rio_mask

import _common as C

# The "real" heatmap folder is the LOCAL one next to the numbered scripts
# (output/), the same one STEP 5 writes to and STEP 6 reads from.
# NB: C.OUTPUT_DIR may point to the shared output of pipe_completa
# (.../script/output/heatmap), which in this structure does NOT contain the .tif.
# For consistency with the flow 5 -> 5b -> 6 I therefore use the local output/.
QUI = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR_LOCALE = os.path.join(QUI, "output")


def log(msg):
    print(f"[ritaglia_heatmap] {msg}", flush=True)


def _carica_confine_nel_crs(raster_crs):
    """Loads the city boundary (lau_eurostat) and reprojects it into the raster CRS."""
    gdf = gpd.read_file(C.CONFINE_GPKG, layer=C.CONFINE_LAYER)
    if gdf.crs is None:
        # the LAU Eurostat boundaries are in lat/lon if they lack an explicit CRS
        gdf = gdf.set_crs(C.CRS_WGS84)
    gdf = gdf.to_crs(raster_crs)
    # merge all features into a single geometry (the municipality may have several polygons)
    geom = gdf.geometry.union_all()
    return [geom]


def ritaglia_tif(path_tif, geometrie):
    """Masks a GeoTIFF on the boundary, keeping extent/grid; overwrites the file."""
    with rasterio.open(path_tif) as src:
        profile = src.profile.copy()
        nodata = src.nodata if src.nodata is not None else 0
        # crop=False -> does NOT clip the extent: keeps the same grid and sets
        # to nodata everything outside the boundary (borders consistent with the map).
        out_img, out_transform = rio_mask(
            src,
            geometrie,
            crop=False,
            nodata=nodata,
            filled=True,
            all_touched=True,   # keeps the edge cells touched by the boundary
        )

    profile.update({
        "height": out_img.shape[1],
        "width": out_img.shape[2],
        "transform": out_transform,
        "nodata": nodata,
        "compress": "deflate",
    })

    with rasterio.open(path_tif, "w", **profile) as dst:
        dst.write(out_img)


def main():
    out_dir = OUTPUT_DIR_LOCALE
    log(f"Heatmap folder:  {out_dir}")
    log(f"City boundary:   {C.CONFINE_GPKG} (layer '{C.CONFINE_LAYER}')")

    if not os.path.isfile(C.CONFINE_GPKG):
        raise FileNotFoundError(
            f"Boundary not found: {C.CONFINE_GPKG}. "
            "Check that data/lau_eurostat.gpkg exists."
        )

    # All the raster heatmaps produced by step 5 (raw + reds previews)
    tif_list = sorted(glob.glob(os.path.join(out_dir, "heatmap_*.tif")))
    # exclude any .aux.xml sidecars (they are not rasters to be masked)
    tif_list = [p for p in tif_list if not p.endswith(".aux.xml")]

    if not tif_list:
        log("No heatmap_*.tif found: run step 5 first.")
        return

    # per-CRS boundary cache (avoid re-reading/re-projecting every time)
    confine_per_crs = {}
    n_ok = 0
    for path in tif_list:
        try:
            with rasterio.open(path) as src:
                crs = src.crs.to_string() if src.crs else C.CRS_WGS84
            if crs not in confine_per_crs:
                confine_per_crs[crs] = _carica_confine_nel_crs(crs)
            ritaglia_tif(path, confine_per_crs[crs])
            n_ok += 1
            log(f"  clipped on the boundary: {os.path.basename(path)}")
        except Exception as e:
            log(f"  [ERROR] {os.path.basename(path)}: {e}")

    log(f"DONE. Heatmaps clipped on the boundary: {n_ok}/{len(tif_list)}")


if __name__ == "__main__":
    main()
