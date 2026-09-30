# -*- coding: utf-8 -*-
"""
STEP 08b - OPTIMIZES transport_15min for the dashboard.

The "Transport stop accessability" layer (15-min polygons with the walking minutes
to the nearest stop) on large cities (Madrid: 178k polygons, 1.2M vertices,
75 MB, coordinates with 15 decimals) is extremely heavy: the dashboard takes a long time to
load it and, on top of that, it does NOT get colored because the minutes field is named 'stop'
while the frontend looks for 'transport_stop'.

This step regenerates the file in a LIGHT but VISUALLY IDENTICAL version:
  1. RENAMES the minutes field  stop -> transport_stop  (so the dashboard
     colors it: styleForPolygon reads properties['transport_stop']).
  2. SIMPLIFIES the geometries with a very small tolerance (~1.5 m) to remove
     redundant vertices while keeping the shape of the cells.
  3. TRUNCATES the coordinates to 5 decimals (~1 m precision, invisible on screen).
  4. Writes a compact GeoJSON (separators without spaces).

Input : data/transport_15min.geojson  (field 'stop' = minutes, coord 15 decimals)
Output: output/transport_15min.geojson (field 'transport_stop', light)

Step 09_sync_assets takes transport_15min.geojson from output/ if present,
otherwise from data/ (fallback).
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
import geopandas as gpd
from shapely.geometry import mapping

# simplification tolerance in DEGREES.
# ~8 m at the latitude of Madrid: at city zoom level the 15-min cells
# remain visually identical (the cell border is already irregular), but many
# redundant micro-vertices are removed. 1 lon degree ~ 85 km at lat 40 ->
# 8 m ~ 9.4e-5 degrees.
SIMPLIFY_TOL = 0.00009
# coordinate decimals in output (5 -> ~1 m, invisible on screen).
DECIMALI = 5


def _round_coords(obj, nd):
    """Recursively rounds all coordinates of a GeoJSON geometry."""
    if isinstance(obj, (int, float)):
        return round(obj, nd)
    if isinstance(obj, list):
        return [_round_coords(x, nd) for x in obj]
    return obj


def main():
    src = P.data("transport_15min.geojson")
    if not os.path.exists(src):
        print(f"ERROR: missing {src}")
        sys.exit(1)

    print("STEP 08b . Optimizing transport_15min for the dashboard")
    size_in = os.path.getsize(src) / 1e6
    print(f"  input: {size_in:.1f} MB")

    gdf = gpd.read_file(src)
    print(f"  feature: {len(gdf)} | CRS: {gdf.crs}")

    ALIAS_MINUTI = [
        "transport_stop", "stop", "minutes", "min", "walk_min", "min_walk",
        "walk_minutes", "walkmin", "minuti", "min_piedi", "walk_time", "time_walk",
    ]

    def _is_plausibile_minuti(serie):
        """True if the column looks like 'walking minutes': mostly numeric,
        values between 0 and ~90 (also accepts strings like '> 60')."""
        vals = []
        for v in serie.dropna().tolist():
            if isinstance(v, (int, float)):
                vals.append(float(v))
            else:
                s = str(v).replace(">", "").replace("<", "").replace("min", "").strip()
                try:
                    vals.append(float(s))
                except (ValueError, TypeError):
                    pass
        if not vals:
            return False
        # at least 70% of the values must be convertible to a number
        if len(vals) < 0.7 * max(1, serie.notna().sum()):
            return False
        vmin, vmax = min(vals), max(vals)
        return vmin >= 0.0 and vmax <= 90.0

    def _media_minuti(serie):
        """Mean of the numeric values (minutes) of a column, to disambiguate."""
        vals = []
        for v in serie.dropna().tolist():
            s = str(v).replace(">", "").replace("<", "").replace("min", "").strip()
            try:
                vals.append(float(s))
            except (ValueError, TypeError):
                pass
        return (sum(vals) / len(vals)) if vals else 999.0

    col_minuti = None
    # a) match by known name (case-insensitive), preserving the order of ALIAS_MINUTI
    lower_map = {c.lower(): c for c in gdf.columns}
    for alias in ALIAS_MINUTI:
        if alias in lower_map:
            col_minuti = lower_map[alias]
            break
    # b) fallback: plausible numeric column (0..90 minutes)
    if col_minuti is None:
        candidate = [c for c in gdf.columns
                     if c != "geometry" and _is_plausibile_minuti(gdf[c])]
        if len(candidate) == 1:
            col_minuti = candidate[0]
            print(f"  minutes field AUTO-DETECTED: '{col_minuti}' (only 0..90 column)")
        elif len(candidate) > 1:
            # if ambiguous, prefer the one with the lowest mean (walking
            # minutes are typically small). Warn anyway.
            col_minuti = min(candidate, key=_media_minuti)
            print(f"  minutes field AMBIGUOUS among {candidate}; chosen '{col_minuti}'.")


    if col_minuti is None:
        print("  ERROR: no recognized/plausible minutes field.")
        print(f"          Columns present: {list(gdf.columns)}")
        print("          Expected (aliases): " + ", ".join(ALIAS_MINUTI))
        sys.exit(2)

    if col_minuti != "transport_stop":
        gdf = gdf.rename(columns={col_minuti: "transport_stop"})
        print(f"  field '{col_minuti}' -> 'transport_stop'")


    # keep ONLY the minutes field (the other columns are not needed by the layer and add weight)
    keep = [c for c in ("transport_stop",) if c in gdf.columns]
    gdf = gdf[keep + ["geometry"]]

    # 2) geometry simplification (preserve_topology to avoid punching holes in the cells)
    if gdf.crs is None:
        gdf.set_crs(4326, inplace=True)
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_TOL, preserve_topology=True)
    # discard any geometries that became empty/null
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()].reset_index(drop=True)

    # 3+4) build the GeoJSON by hand to truncate the coordinates and write compactly
    feats = []
    for _, row in gdf.iterrows():
        geom = mapping(row.geometry)
        geom["coordinates"] = _round_coords(geom["coordinates"], DECIMALI)
        val = row.get("transport_stop", None)
        # normalize the minutes value: number if possible, otherwise string (e.g. "> 60")
        props = {}
        if val is not None:
            try:
                fv = float(val)
                # keep 2 decimals max (the minutes don't need to be more precise)
                props["transport_stop"] = round(fv, 2)
            except (ValueError, TypeError):
                props["transport_stop"] = str(val)
        feats.append({"type": "Feature", "properties": props, "geometry": geom})

    fc = {"type": "FeatureCollection", "features": feats}

    n_num = 0
    for ft in feats:
        v = ft["properties"].get("transport_stop")
        if isinstance(v, (int, float)):
            n_num += 1
    frac = n_num / max(1, len(feats))
    print(f"  cells with numeric minutes: {n_num}/{len(feats)} ({frac*100:.1f}%)")
    if frac < 0.5:
        print("  ERROR: less than 50% of the cells have a numeric minutes value:")
        print("          the layer would NOT get colored. Check the minutes field")
        print("          in the input data/transport_15min.geojson.")
        sys.exit(3)

    dst = P.out("transport_15min.geojson")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))

    size_out = os.path.getsize(dst) / 1e6
    print(f"  output: {size_out:.1f} MB ({dst})")
    print(f"  REDUCTION: {size_in:.1f} MB -> {size_out:.1f} MB "
          f"({100*(1-size_out/size_in):.0f}% less)")

    P.riepilogo(feature=len(feats), mb_in=round(size_in, 1), mb_out=round(size_out, 1))
    print("OK -> output/transport_15min.geojson (transport_stop field, light)")


if __name__ == "__main__":
    main()
