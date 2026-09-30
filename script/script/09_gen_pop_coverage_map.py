# -*- coding: utf-8 -*-
r"""
STEP 03.5 - AUTOMATICALLY GENERATES data/pop_coverage_map.gpkg
============================================================================
Luca's request: the "Population coverage" layer (pop_coverage_map.gpkg) must NOT
be a STATIC file exported by hand from QGIS anymore, but must be RECOMPUTED by the
pipeline at each run, city-agnostic.

This step FAITHFULLY replicates the logic of the GTFS-2-GIS plugin
(qgis_gtfs_plugin/core/layer_factory.py), already reproduced in
qgis_gtfs_plugin-main/prova_pop_coverage/prova_pop_coverage.py:
    - create_walking_reach()          -> 400 m buffer around the stops
    - calculate_population_coverage() -> AREA-BASED cell/reach intersection

For each population cell (GHSL 3 arcsec, ~90 m) it computes:
    pct_covered   : % of the cell AREA covered by the walking reach (0..100)
    pop           : residents living in the cell (real GHSL data)
    pop_covered   : covered residents   = pop * ratio_area
    pop_uncovered : uncovered residents = pop - pop_covered
    pop_tot       : alias of 'pop' (the frontend reads pop_tot in the popup)
    color         : Purples color (5 bands) of the pop_coverage QML, for QGIS

INPUT (already produced by the previous pipeline steps):
    output/pop_2025_cells.geojson   (GHSL cells 3 arcsec ~90 m, field 'pop')  <- step 03_4
    output/stop.geojson             (stops)                              <- step 01
OUTPUT:
    data/pop_coverage_map.gpkg      (then read by step 04 and 05b)

DOWNSTREAM FLOW (no changes needed to the other steps):
    step 04  : data/pop_coverage_map.gpkg -> output/population_coverage.geojson
    step 05b : enriches with pop_tot/pop_covered/pop_uncovered (accurate spatial
               join with the population cells) and overwrites the geojson
    step 09  : output/population_coverage.geojson -> assets/pop_coverage_map.geojson

CITY-AGNOSTIC: the metric CRS for the buffer/areas is NOT hardcoded to Madrid
(EPSG:25830). It is computed AUTOMATICALLY from the data centroid with the
correct UTM/WGS84 zone (useful for Leuven, Madrid, or any other city).
============================================================================
"""
import os
import sys
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out, riepilogo = P.data, P.out, P.riepilogo

import geopandas as gpd
import pandas as pd
from shapely.ops import unary_union


WALK_DISTANCE_M = 400.0     # buffer around the stops (~400 m, like the plugin)
POP_FIELD = "pop"           # population field of the GHSL cells
WGS84 = "EPSG:4326"

COVERAGE_RANGES = [
    (0.0,   0.0,   "#f2f0f7"),   # 0%
    (0.1,   25.0,  "#cbc9e2"),   # 1-25%
    (25.1,  50.0,  "#9e9ac8"),   # 25-50%
    (50.1,  75.0,  "#756bb1"),   # 50-75%
    (75.1,  100.0, "#54278f"),   # 75-100%
]


def color_for_pct(pct):
    """Purples color of the plugin palette for a given pct (0..100)."""
    if pct <= 0.0:
        return "#f2f0f7"
    for low, high, color in COVERAGE_RANGES:
        if low <= pct <= high:
            return color
    return "#54278f"


def utm_crs_for(gdf_wgs84):
    """
    CITY-AGNOSTIC: computes the metric UTM/WGS84 CRS best suited to the data, from
    their centroid. This way the 400 m buffer and the area calculations are correct in
    meters for ANY city (Leuven zone 31N -> EPSG:32631, Madrid 30N ->
    EPSG:32630, ...) without hardcoding the zone.
    """
    # mean centroid in lon/lat (fast union of the bounds)
    minx, miny, maxx, maxy = gdf_wgs84.total_bounds
    lon = (minx + maxx) / 2.0
    lat = (miny + maxy) / 2.0
    zone = int(math.floor((lon + 180.0) / 6.0) + 1)
    # EPSG 326xx = UTM North, 327xx = UTM South
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return "EPSG:%d" % epsg


def build_walking_reach(stops_gdf, metric_crs):
    """400 m buffer around the stops, in metric CRS. Returns a single
    unified geometry (equivalent to the plugin's QgsGeometry.unaryUnion)."""
    stops_m = stops_gdf.to_crs(metric_crs)
    buffers = stops_m.geometry.buffer(WALK_DISTANCE_M)
    return unary_union(buffers.values)   # == plugin's unaryUnion


def calculate_population_coverage(cells_m, unified_walking, pop_field=POP_FIELD):

    records = []
    total_pop_covered = 0.0

    for _, feat in cells_m.iterrows():
        geom = feat.geometry
        raw = feat[pop_field]
        pop_val = float(raw) if raw is not None and not pd.isna(raw) else 0.0

        if geom is None or geom.is_empty or not geom.intersects(unified_walking):
            records.append({
                "geometry": geom, "pct_covered": 0.0, "pop": pop_val,
                "pop_covered": 0.0, "pop_uncovered": pop_val,
                "pop_tot": pop_val, "color": color_for_pct(0.0),
            })
            continue

        intersection = geom.intersection(unified_walking)
        if intersection.is_empty:
            records.append({
                "geometry": geom, "pct_covered": 0.0, "pop": pop_val,
                "pop_covered": 0.0, "pop_uncovered": pop_val,
                "pop_tot": pop_val, "color": color_for_pct(0.0),
            })
            continue

        area_cell = geom.area
        ratio = (intersection.area / area_cell) if area_cell > 0 else 0.0
        pct = min(100.0, ratio * 100.0)   # clamp identical to the plugin

        pop_covered = pop_val * ratio
        pop_uncovered = pop_val - pop_covered
        total_pop_covered += pop_covered

        records.append({
            "geometry": geom,
            "pct_covered": round(pct, 4),
            "pop": round(pop_val, 4),
            "pop_covered": round(pop_covered, 4),
            "pop_uncovered": round(pop_uncovered, 4),
            "pop_tot": round(pop_val, 4),
            "color": color_for_pct(pct),
        })

    result = gpd.GeoDataFrame(records, crs=cells_m.crs)
    return result, total_pop_covered


def main():
    cells_path = out("pop_2025_cells.geojson")   # GHSL cells with 'pop' (step 03_4)
    stops_path = out("stop.geojson")              # stops (step 01)
    dst_gpkg = data("pop_coverage_map.gpkg")      # <- output of this step

    print("STEP 03.5 . Generating data/pop_coverage_map.gpkg (coverage from walking reach)")

    if not os.path.exists(cells_path):
        print("ERROR: missing output/pop_2025_cells.geojson (run step 03_4 first).")
        sys.exit(1)
    if not os.path.exists(stops_path):
        print("ERROR: missing output/stop.geojson (run step 01 first).")
        sys.exit(1)

    # --- read input (in WGS84) ---
    cells = gpd.read_file(cells_path)
    stops = gpd.read_file(stops_path)
    if cells.crs is None:
        cells.set_crs(WGS84, inplace=True)
    if stops.crs is None:
        stops.set_crs(WGS84, inplace=True)
    cells = cells.to_crs(WGS84)
    stops = stops.to_crs(WGS84)

    if POP_FIELD not in cells.columns:
        print("ERROR: the population cells do not have the 'pop' field.")
        sys.exit(1)
    cells[POP_FIELD] = pd.to_numeric(cells[POP_FIELD], errors="coerce").fillna(0.0)

    # --- city-agnostic metric CRS (UTM from the centroid) ---
    metric_crs = utm_crs_for(cells)
    print("  population cells:", len(cells),
          "| total pop:", int(cells[POP_FIELD].sum()),
          "| stops:", len(stops), "| metric CRS:", metric_crs)

    # --- walking reach (unified 400 m buffer) ---
    unified_walking = build_walking_reach(stops, metric_crs)

    # --- area-based coverage (in metric CRS) ---
    cells_m = cells.to_crs(metric_crs)
    result_m, total_pop_covered = calculate_population_coverage(cells_m, unified_walking)

    # --- statistics ---
    pop_tot = float(result_m["pop"].sum())
    pop_cov = float(result_m["pop_covered"].sum())
    pop_unc = float(result_m["pop_uncovered"].sum())
    pct_str = ("%.1f" % (pop_cov / pop_tot * 100.0)) if pop_tot > 0 else "0.0"
    print("  output cells:", len(result_m),
          "| pop tot:", int(pop_tot),
          "| covered:", int(pop_cov), "(" + pct_str + "%)",
          "| uncovered:", int(pop_unc))

    # --- back to WGS84 and save the GPKG (then read by step 04) ---
    result = result_m.to_crs(WGS84)
    cols = ["pct_covered", "pop", "pop_tot", "pop_covered", "pop_uncovered", "color", "geometry"]
    result = result[cols]

    os.makedirs(os.path.dirname(dst_gpkg), exist_ok=True)
    if os.path.exists(dst_gpkg):
        os.remove(dst_gpkg)
    # layer name 'pop_coverage_map' for consistency with the historical file
    result.to_file(dst_gpkg, driver="GPKG", layer="pop_coverage_map")

    riepilogo(celle=len(result), pop_tot=int(pop_tot),
              coperti=int(pop_cov), scoperti=int(pop_unc))
    print("OK -> data/pop_coverage_map.gpkg (pct_covered/pop/pop_covered/pop_uncovered/color)")


if __name__ == "__main__":
    main()
