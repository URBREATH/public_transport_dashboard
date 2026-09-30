# -*- coding: utf-8 -*-
"""
00a_gen_gpkg_from_grezzi.py

Generates stop.gpkg and line.gpkg (3 bus/metro/tram layers, but ONLY for the modes
actually present in raw_data/) directly from the raw GTFS feeds,
then CLIPS everything on the municipal boundary lau_eurostat.gpkg.

Output (written in OUT_DIR, default = data/):
    stop.gpkg   -> one layer per present mode, Point, EPSG:4326
    line.gpkg   -> one layer per present mode, MultiLineString, EPSG:4326

Column schema replicated IDENTICALLY to the one expected by the pipeline (verified
with _diag_schema.py on the original data_separati/*.gpkg files).

CITY-AGNOSTIC: if a mode folder is missing, that layer is not created; if the
LAU boundary is missing, the clip is skipped (with a warning).
"""
import os, sys, csv, argparse
from collections import defaultdict

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point, LineString, MultiLineString

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))            # dashboard/script
RAW_ROOT = os.path.join(ROOT, "data", "raw_data")
LAU_DEFAULT = os.path.join(ROOT, "data", "lau_eurostat.gpkg")

# Target columns (order as in the original files)
STOP_COLS = ["stop_id", "name", "location_type", "parent_station", "stop_code",
             "platform", "routes", "is_terminal", "terminal_routes", "stop_desc",
             "lat", "lon", "lines_count", "all_transit_types", "most_frequent_type"]
LINE_COLS = ["shape_id", "route_id", "line", "name", "route_desc", "agency",
             "destination", "direction", "transit_type", "fare", "color",
             "frequency", "shape_ext", "start_time", "end_time", "start_period"]


def read_dicts(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def find_modes(raw_root):
    """Returns the list of present mode-subfolders that contain
    at least stops.txt (for stop) or shapes.txt (for line)."""
    if not os.path.isdir(raw_root):
        return []
    modes = []
    for name in sorted(os.listdir(raw_root)):
        d = os.path.join(raw_root, name)
        if not os.path.isdir(d):
            continue
        if os.path.exists(os.path.join(d, "stops.txt")) or \
           os.path.exists(os.path.join(d, "shapes.txt")):
            modes.append(name)
    return modes


# ---------------------------------------------------------------------------
# STOP: from stops.txt -> point layer
# ---------------------------------------------------------------------------
def build_stop_layer(mode_dir):
    stops = read_dicts(os.path.join(mode_dir, "stops.txt"))
    if not stops:
        return None

    # routes per stop: from trips + stop_times + routes (route_short_name)
    routes_by_stop = defaultdict(set)
    terminal_by_stop = defaultdict(set)
    route_short = {}
    for r in read_dicts(os.path.join(mode_dir, "routes.txt")):
        route_short[r.get("route_id", "")] = (r.get("route_short_name", "")
                                              or r.get("route_long_name", ""))
    trip_route = {}
    for r in read_dicts(os.path.join(mode_dir, "trips.txt")):
        trip_route[r.get("trip_id", "")] = r.get("route_id", "")

    st_path = os.path.join(mode_dir, "stop_times.txt")
    if os.path.exists(st_path):
        # first/last per trip -> terminus
        trip_seq = defaultdict(list)  # tid -> [(seq, stop_id)]
        for chunk in pd.read_csv(st_path, usecols=["trip_id", "stop_id", "stop_sequence"],
                                 dtype=str, chunksize=1_000_000):
            for tid, sid, seq in zip(chunk["trip_id"], chunk["stop_id"], chunk["stop_sequence"]):
                rid = trip_route.get(tid, "")
                line = route_short.get(rid, "")
                if line:
                    routes_by_stop[sid].add(line)
                try:
                    s = int(seq)
                except (TypeError, ValueError):
                    s = None
                if s is not None:
                    trip_seq[tid].append((s, sid, line))
        for tid, lst in trip_seq.items():
            if not lst:
                continue
            lst.sort(key=lambda x: x[0])
            for _, sid, line in (lst[0], lst[-1]):
                if line:
                    terminal_by_stop[sid].add(line)

    rows = []
    geoms = []
    for r in stops:
        sid = str(r.get("stop_id", "") or "").strip()
        if not sid:
            continue
        try:
            lat = float(r.get("stop_lat"))
            lon = float(r.get("stop_lon"))
        except (TypeError, ValueError):
            continue
        rts = sorted(routes_by_stop.get(sid, set()),
                     key=lambda x: (0, int(x)) if str(x).isdigit() else (1, str(x)))
        term = terminal_by_stop.get(sid, set())
        rows.append({
            "stop_id": sid,
            "name": r.get("stop_name", "") or "",
            "location_type": r.get("location_type", "") or "",
            "parent_station": r.get("parent_station", "") or "",
            "stop_code": r.get("stop_code", "") or "",
            "platform": r.get("platform_code", "") or "",
            "routes": ",".join(rts),
            "is_terminal": "yes" if term else "",
            "terminal_routes": ",".join(sorted(term)),
            "stop_desc": r.get("stop_desc", "") or "",
            "lat": lat,
            "lon": lon,
            "lines_count": len(rts),
            "all_transit_types": "",
            "most_frequent_type": "",
        })
        geoms.append(Point(lon, lat))

    if not rows:
        return None
    gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs="EPSG:4326")
    return gdf[STOP_COLS + ["geometry"]]


# ---------------------------------------------------------------------------
# LINE: from shapes.txt -> polyline layer, enriched with routes/trips
# ---------------------------------------------------------------------------
def build_line_layer(mode_dir):
    shapes = read_dicts(os.path.join(mode_dir, "shapes.txt"))
    if not shapes:
        return None

    # rebuild polylines per shape_id
    pts = defaultdict(list)  # shape_id -> [(seq, lon, lat)]
    for r in shapes:
        shp = str(r.get("shape_id", "") or "").strip()
        if not shp:
            continue
        try:
            lat = float(r.get("shape_pt_lat"))
            lon = float(r.get("shape_pt_lon"))
            seq = int(r.get("shape_pt_sequence"))
        except (TypeError, ValueError):
            continue
        pts[shp].append((seq, lon, lat))

    # route info
    route_info = {}
    for r in read_dicts(os.path.join(mode_dir, "routes.txt")):
        rid = r.get("route_id", "")
        col = (r.get("route_color", "") or "").strip().lstrip("#")
        route_info[rid] = {
            "line": r.get("route_short_name", "") or r.get("route_long_name", "") or "",
            "name": r.get("route_long_name", "") or r.get("route_short_name", "") or "",
            "route_desc": r.get("route_desc", "") or "",
            "transit_type": r.get("route_type", "") or "",
            "color": ("#" + col) if len(col) == 6 else "",
            "url": r.get("route_url", "") or "",
        }
    # agency
    agencies = read_dicts(os.path.join(mode_dir, "agency.txt"))
    agency_name = agencies[0].get("agency_name", "") if agencies else ""

    # shape_id -> (route_id, headsign, direction) from trips
    shape_meta = {}
    for r in read_dicts(os.path.join(mode_dir, "trips.txt")):
        shp = str(r.get("shape_id", "") or "").strip()
        if not shp or shp in shape_meta:
            continue
        shape_meta[shp] = (r.get("route_id", ""),
                           r.get("trip_headsign", "") or "",
                           r.get("direction_id", "") or "")

    rows = []
    geoms = []
    for shp, plist in pts.items():
        if len(plist) < 2:
            continue
        plist.sort(key=lambda x: x[0])
        line_geom = LineString([(lon, lat) for _, lon, lat in plist])
        rid, headsign, direction = shape_meta.get(shp, ("", "", ""))
        ri = route_info.get(rid, {})
        rows.append({
            "shape_id": shp,
            "route_id": rid,
            "line": ri.get("line", ""),
            "name": ri.get("name", ""),
            "route_desc": ri.get("route_desc", ""),
            "agency": agency_name,
            "destination": headsign,
            "direction": direction,
            "transit_type": ri.get("transit_type", ""),
            "fare": "",
            "color": ri.get("color", ""),
            "frequency": 0,
            "shape_ext": "",
            "start_time": "",
            "end_time": "",
            "start_period": "",
        })
        geoms.append(MultiLineString([line_geom]))

    if not rows:
        return None
    gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs="EPSG:4326")
    return gdf[LINE_COLS + ["geometry"]]


def clip_to_lau(gdf, lau_gdf):
    """Clips a layer on the LAU polygon. For points it keeps those INSIDE;
    for lines it cuts on the boundary."""
    if gdf is None or lau_gdf is None or gdf.empty:
        return gdf
    try:
        return gpd.clip(gdf, lau_gdf)
    except Exception as e:
        print(f"    [!] clip failed ({e}), returning unclipped layer")
        return gdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=RAW_ROOT)
    ap.add_argument("--lau", default=LAU_DEFAULT)
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--no-clip", action="store_true")

    ap.add_argument("--no-clip-stop", action="store_true",
                    help="Do NOT clip the stops on LAU (keeps all the raw ones)")
    args = ap.parse_args()

    print("=" * 70)
    print("STEP 00a - generating stop.gpkg / line.gpkg from the raw GTFS")
    print("  raw :", args.raw)
    print("  lau :", args.lau)
    print("  out :", args.out)

    modes = find_modes(args.raw)
    print("  MODES found:", modes if modes else "NONE")
    if not modes:
        print("  [ERROR] no mode folder with stops.txt/shapes.txt. Stop.")
        sys.exit(2)

    os.makedirs(args.out, exist_ok=True)

    # LAU boundary
    lau_gdf = None
    if not args.no_clip and os.path.exists(args.lau):
        lau_gdf = gpd.read_file(args.lau)
        if str(lau_gdf.crs).upper() != "EPSG:4326":
            lau_gdf = lau_gdf.to_crs(4326)
        print(f"  [clip] LAU boundary loaded: {len(lau_gdf)} polygon(s)")
    elif not args.no_clip:
        print(f"  [!] LAU boundary not found ({args.lau}) -> NO clip")

    stop_out = os.path.join(args.out, "stop.gpkg")
    line_out = os.path.join(args.out, "line.gpkg")
    # remove any pre-existing files to rewrite them clean
    for p in (stop_out, line_out):
        if os.path.exists(p):
            os.remove(p)

    stop_written = 0
    line_written = 0
    for mode in modes:
        md = os.path.join(args.raw, mode)
        print(f"\n  == MODE '{mode}' ==")

        s_gdf = build_stop_layer(md)
        if s_gdf is not None and not s_gdf.empty:
            if args.no_clip_stop or args.no_clip or lau_gdf is None:
                print(f"    stop: {len(s_gdf)} (NO clip - all raw stops)")
            else:
                n0 = len(s_gdf)
                s_gdf = clip_to_lau(s_gdf, lau_gdf)
                print(f"    stop: {n0} -> {len(s_gdf)} after clip on LAU")
            if s_gdf is not None and not s_gdf.empty:
                s_gdf.to_file(stop_out, layer=mode, driver="GPKG")
                stop_written += 1
        else:
            print("    stop: no stop (skipping layer)")

        l_gdf = build_line_layer(md)
        if l_gdf is not None and not l_gdf.empty:
            n0 = len(l_gdf)
            l_gdf = clip_to_lau(l_gdf, lau_gdf)
            print(f"    line: {n0} -> {len(l_gdf)} after clip")
            if not l_gdf.empty:
                l_gdf.to_file(line_out, layer=mode, driver="GPKG")
                line_written += 1
        else:
            print("    line: no line (skipping layer)")

    print("\n" + "=" * 70)
    print(f"  DONE. stop.gpkg layer={stop_written} | line.gpkg layer={line_written}")
    print(f"  -> {stop_out}")
    print(f"  -> {line_out}")


if __name__ == "__main__":
    main()
