# -*- coding: utf-8 -*-
import os, sys, csv, json, datetime
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
out = P.out

BASE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GPKG = os.path.join(BASE, "data", "stop.gpkg")
SEP_DIR = os.path.join(BASE, "data", "raw_data")
MODES = ["bus", "metro", "tram"]
MODE_RANK = {"bus": 3, "metro": 2, "tram": 1}   # tie-break prevalent mode
WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def d(s):
    return datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def read_dicts(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))



def load_stop_urls():
    """Returns { stop_id: stop_url } by merging stops.txt of all modes.
    If a stop_id appears in multiple modes, keeps the FIRST non-empty url found.
    If stops.txt or the stop_url field are missing, the stop simply will not have
    the url (the panel will not show the link)."""
    urls = {}
    for mode in MODES:
        raw = os.path.join(SEP_DIR, mode)
        p = os.path.join(raw, "stops.txt")
        if not os.path.exists(p):
            continue
        try:
            for r in read_dicts(p):
                sid = str(r.get("stop_id", "") or "").strip()
                if not sid:
                    continue
                u = (r.get("stop_url", "") or "").strip()
                if u and sid not in urls:
                    urls[sid] = u
        except Exception as e:
            print(f"  [!] stops.txt '{mode}' not readable for stop_url ({e})")
    print(f"  [stop_url] stops with url: {len(urls)}")
    return urls



# ---------------------------------------------------------------------------
# 1) GEOMETRIES + mode from the 3 layers of the GeoPackage (OFFICIAL SOURCE)
# ---------------------------------------------------------------------------
def load_stops_from_gpkg():
    """Reads the bus/metro/tram layers from data_separati/stop.gpkg.
    Returns: per_mode = {mode: {stop_id: {name, lat, lon}}}
    Uses geopandas if available; otherwise pure-sqlite fallback on the GeoPackage.
    """
    per_mode = {m: {} for m in MODES}
    if not os.path.exists(GPKG):
        print(f"  [ERROR] official source not found: {GPKG}")
        return per_mode

    # attempt with geopandas (more robust on geometries)
    try:
        import geopandas as gpd
        for m in MODES:
            try:
                gdf = gpd.read_file(GPKG, layer=m)
            except Exception as e:
                print(f"  [!] layer '{m}' not readable ({e}), skipping")
                continue
            if gdf.crs is not None and str(gdf.crs).upper() not in ("EPSG:4326",):
                gdf = gdf.to_crs(4326)
            for _, row in gdf.iterrows():
                sid = str(row.get("stop_id", "") or "").strip()
                if not sid:
                    continue
                geom = row.geometry
                if geom is None or geom.is_empty:
                    # fallback to lat/lon columns if present
                    try:
                        lat = float(row.get("lat")); lon = float(row.get("lon"))
                    except Exception:
                        continue
                else:
                    lon, lat = float(geom.x), float(geom.y)
                per_mode[m][sid] = {
                    "name": str(row.get("name", "") or ""),
                    "lat": lat, "lon": lon,
                }
            print(f"  [gpkg] layer '{m}': {len(per_mode[m])} stops")
        return per_mode
    except Exception as e:
        print(f"  [i] geopandas not available ({e}) -> sqlite fallback")

    # fallback: read lat/lon from the GeoPackage columns via sqlite
    import sqlite3
    con = sqlite3.connect(GPKG)
    cur = con.cursor()
    for m in MODES:
        try:
            cur.execute(f'PRAGMA table_info("{m}")')
            cols = [c[1] for c in cur.fetchall()]
            if not cols:
                continue
            has_latlon = "lat" in cols and "lon" in cols
            sel = 'stop_id, name' + (', lat, lon' if has_latlon else '')
            cur.execute(f'SELECT {sel} FROM "{m}"')
            for rrow in cur.fetchall():
                sid = str(rrow[0] or "").strip()
                name = rrow[1] or ""
                if not sid:
                    continue
                if has_latlon and rrow[2] is not None and rrow[3] is not None:
                    try:
                        lat = float(rrow[2]); lon = float(rrow[3])
                    except Exception:
                        continue
                    per_mode[m][sid] = {"name": str(name), "lat": lat, "lon": lon}
            print(f"  [gpkg/sqlite] layer '{m}': {len(per_mode[m])} stops")
        except Exception as e:
            print(f"  [!] layer '{m}' sqlite error: {e}")
    con.close()
    return per_mode


def process_mode_metrics(mode, stop_ids):
    """Computes metrics for the mode's 'stop_ids' stops, from the raw GTFS.
    Returns: metrics = {stop_id: {lines:set, shapes:set, routes:set,
                                  is_terminal:bool, passages:float, minmax:[a,b]}}
             + (active_days, start, end)
    """
    metrics = {sid: {"lines": set(), "shapes": set(), "routes": set(),
                     "lines_map": {},
                     "is_terminal": False, "passages": 0.0, "minmax": None}
               for sid in stop_ids}
    raw = os.path.join(SEP_DIR, mode)
    if not os.path.isdir(raw):
        print(f"  [!] GTFS feed '{mode}' missing: metrics at 0 for this mode")
        return metrics, (0, None, None)

    route_short = {}
    route_color = {}   # route_id -> "#RRGGBB" (from GTFS route_color)
    route_url = {}     # route_id -> line url (from GTFS route_url)
    for r in read_dicts(os.path.join(raw, "routes.txt")):
        route_short[r["route_id"]] = (r.get("route_short_name", "")
                                      or r.get("route_long_name", ""))
        col = (r.get("route_color", "") or "").strip().lstrip("#")
        route_color[r["route_id"]] = ("#" + col) if len(col) == 6 else ""
        route_url[r["route_id"]] = (r.get("route_url", "") or "").strip()

    trip_info = {}
    for r in read_dicts(os.path.join(raw, "trips.txt")):
        trip_info[r["trip_id"]] = (r["route_id"], r["service_id"],
                                   r.get("trip_headsign", ""))

    service_days = defaultdict(set)
    cal = os.path.join(raw, "calendar.txt")
    if os.path.exists(cal):
        for r in read_dicts(cal):
            sid = r["service_id"]
            start, end = d(r["start_date"]), d(r["end_date"])
            active_wd = [i for i in range(7) if r.get(WEEK[i], "0") == "1"]
            cur, one = start, datetime.timedelta(days=1)
            while cur <= end:
                if cur.weekday() in active_wd:
                    service_days[sid].add(cur)
                cur += one
    cdates = os.path.join(raw, "calendar_dates.txt")
    if os.path.exists(cdates):
        for r in read_dicts(cdates):
            sid = r["service_id"]; dd = d(r["date"])
            if r.get("exception_type") == "1":
                service_days[sid].add(dd)
            else:
                service_days[sid].discard(dd)

    used_services = set(sid for (_, sid, _) in trip_info.values())
    mode_dates = set()
    for sid in used_services:
        mode_dates |= service_days.get(sid, set())
    active_days = len(mode_dates)
    start = min(mode_dates).isoformat() if mode_dates else None
    end = max(mode_dates).isoformat() if mode_dates else None

    def ndays(sid):
        return len(service_days.get(sid, ()))

    import pandas as pd
    path = os.path.join(raw, "stop_times.txt")
    CH = 1_000_000
    STOP_IDS = set(stop_ids)

    trip_first_last = {}
    print(f"  >> {mode}: pass over stop_times...")
    reader = pd.read_csv(path, usecols=["trip_id", "stop_id", "stop_sequence",
                                        "departure_time", "arrival_time"],
                         dtype=str, chunksize=CH)
    trip_local_stops = defaultdict(set)
    trip_start_min = {}
    for part in P.progress(reader, desc=f"{mode} stop_times", unit="chunk"):
        hit = part[part["stop_id"].isin(STOP_IDS)]
        if hit.empty:
            continue
        for tid, sid, seq, dep, arr in zip(hit["trip_id"], hit["stop_id"],
                                           hit["stop_sequence"],
                                           hit["departure_time"], hit["arrival_time"]):
            trip_local_stops[tid].add(sid)
            t = dep or arr
            try:
                h, mnt, _ = t.split(":")
                mins = int(h) * 60 + int(mnt)
            except Exception:
                mins = None
            if mins is not None:
                cur = trip_start_min.get(tid)
                if cur is None or mins < cur:
                    trip_start_min[tid] = mins
            try:
                s = int(seq)
            except (TypeError, ValueError):
                s = None
            if s is not None:
                fl = trip_first_last.get(tid)
                if fl is None:
                    trip_first_last[tid] = [(s, sid), (s, sid)]
                else:
                    if s < fl[0][0]:
                        fl[0] = (s, sid)
                    if s > fl[1][0]:
                        fl[1] = (s, sid)

    terminal_ids = set()
    for tid, fl in trip_first_last.items():
        for _, sid in (fl[0], fl[1]):
            if sid in metrics:
                terminal_ids.add(sid)

    for tid, sids in trip_local_stops.items():
        ti = trip_info.get(tid)
        if not ti:
            continue
        rid, sid_srv, headsign = ti
        line = route_short.get(rid, "?")
        color = route_color.get(rid, "")
        url = route_url.get(rid, "")
        nd = ndays(sid_srv)
        if nd <= 0:
            continue
        smin = trip_start_min.get(tid)
        for st in sids:
            if st not in metrics:
                continue
            s = metrics[st]
            s["passages"] += nd
            s["lines"].add(line)
            s["routes"].add(line)
            s["shapes"].add((line, headsign))
            # line tree -> {color, shapes(terminus)}
            lm = s["lines_map"].get(line)
            if lm is None:
                lm = {"color": color, "url": url, "shapes": set()}
                s["lines_map"][line] = lm
            if color and not lm["color"]:
                lm["color"] = color
            if url and not lm.get("url"):
                lm["url"] = url
            if headsign:
                lm["shapes"].add(headsign)
            if smin is not None:
                mm = s["minmax"]
                if mm is None:
                    s["minmax"] = [smin, smin]
                else:
                    if smin < mm[0]:
                        mm[0] = smin
                    if smin > mm[1]:
                        mm[1] = smin

    for st in terminal_ids:
        if st in metrics:
            metrics[st]["is_terminal"] = True

    served = sum(1 for s in metrics.values() if s["passages"] > 0)
    print(f"     {mode}: stops in gpkg={len(stop_ids)} | with passages={served} "
          f"| active_days={active_days}")
    return metrics, (active_days, start, end)


def service_hours(minmax):
    if not minmax:
        return 1.0
    span = max(minmax[1] - minmax[0], 0) + 1
    return max(span / 60.0, 1.0)


def main():
    print("STEP 02 - single stops file from the OFFICIAL SOURCE data/stop.gpkg")
    print("  gpkg:", GPKG)

    # 1) geometries + mode from the 3 gpkg layers
    per_mode_geom = load_stops_from_gpkg()

    # 1b) PATCH-LUCA "stopinfo-stop-url-2026-10-09": stop_url per stop_id from GTFS
    stop_urls = load_stop_urls()

    # 2) metrics from GTFS, for the stop_id of each layer
    all_modes = {}
    mode_meta = {}
    for mode in MODES:
        geoms = per_mode_geom.get(mode, {})
        metrics, meta = process_mode_metrics(mode, set(geoms.keys()))
        # merge geometry (gpkg) + metrics (gtfs)
        merged = {}
        for sid, g in geoms.items():
            mt = metrics.get(sid, {"lines": set(), "shapes": set(), "routes": set(),
                                   "lines_map": {},
                                   "is_terminal": False, "passages": 0.0, "minmax": None})
            merged[sid] = {
                "name": g["name"], "lat": g["lat"], "lon": g["lon"],
                "lines": mt["lines"], "shapes": mt["shapes"], "routes": mt["routes"],
                "lines_map": mt.get("lines_map", {}),
                "is_terminal": mt["is_terminal"], "passages": mt["passages"],
                "minmax": mt["minmax"],
            }
        all_modes[mode] = merged
        mode_meta[mode] = {"active_days": meta[0], "start": meta[1], "end": meta[2]}

    geo = {}
    for mode in MODES:
        for sid, s in all_modes[mode].items():
            coord = (round(s["lat"], 5), round(s["lon"], 5))
            g = geo.get(coord)
            if g is None:
                # first occupant of this point: key = coordinate only
                geo[coord] = {"stop_id": sid, "name": s["name"],
                              "lat": s["lat"], "lon": s["lon"],
                              "modes": {mode: s}}
            elif mode not in g["modes"]:
                # same point, DIFFERENT MODE -> legitimate merge (cross-mode)
                g["modes"][mode] = s
                if not g["name"]:
                    g["name"] = s["name"]
            else:
                # same point, SAME mode (e.g. par + est of the metro):
                # do NOT merge -> separate feature with disambiguated key
                geo[(coord, mode, sid)] = {"stop_id": sid, "name": s["name"],
                                           "lat": s["lat"], "lon": s["lon"],
                                           "modes": {mode: s}}

    # 4) geojson features + stats
    features = []
    stats = {}
    for key, g in geo.items():
        modes_here = g["modes"]
        shared = sorted(modes_here.keys())
        # prevalent mode: most passages; on a tie (0 passages) use MODE_RANK
        prevalent = max(shared, key=lambda m: (modes_here[m]["passages"],
                                               MODE_RANK.get(m, 0)))
        lines = set(); shapes = set(); routes = set()
        lines_map = {}
        passages = 0.0; is_term = False; minmax = None
        for m in shared:
            r = modes_here[m]
            lines |= r["lines"]; shapes |= r["shapes"]; routes |= r["routes"]
            for ln, lm in r.get("lines_map", {}).items():
                agg = lines_map.get(ln)
                if agg is None:
                    agg = {"color": lm.get("color", ""), "url": lm.get("url", ""), "shapes": set()}
                    lines_map[ln] = agg
                if lm.get("color") and not agg["color"]:
                    agg["color"] = lm["color"]
                if lm.get("url") and not agg.get("url"):
                    agg["url"] = lm["url"]
                agg["shapes"] |= set(lm.get("shapes", ()))
            passages += r["passages"]
            is_term = is_term or r["is_terminal"]
            if r["minmax"]:
                if minmax is None:
                    minmax = list(r["minmax"])
                else:
                    minmax[0] = min(minmax[0], r["minmax"][0])
                    minmax[1] = max(minmax[1], r["minmax"][1])
        nd = mode_meta[prevalent]["active_days"] or 1
        hours = 24.0
        freq_hourly = round(passages / nd / hours, 2)
        weekly_avg = round(passages / (nd / 7.0), 1)
        sid = g["stop_id"]

        # line tree -> shape (terminus) + line color, naturally sorted
        def _line_key(name):
            s = str(name)
            return (0, int(s)) if s.isdigit() else (1, s)
        lines_detail = []
        for ln in sorted(lines_map.keys(), key=_line_key):
            lm = lines_map[ln]
            lines_detail.append({
                "line": ln,
                "color": lm.get("color", "") or "",
                # PATCH-LUCA "stopinfo-line-url-2026-11-09": line url
                # (route_url from the GTFS feed). If absent -> empty string, and the
                # stop panel shows "linea N" as plain text.
                "url": lm.get("url", "") or "",
                "shapes": sorted(lm.get("shapes", ())),
            })

        stats[sid] = {
            "name": g["name"], "mode": prevalent,
            "lines": len(lines), "shapes": len(shapes),
            "freq_hourly": freq_hourly, "weekly_avg": weekly_avg,
            "line_list": lines_detail,

            "stop_url": stop_urls.get(sid, ""),
        }
        props = {
            "stop_id": sid, "name": g["name"], "mode": prevalent,
            "lines_count": len(lines),

            "freq_hourly": freq_hourly,
            "weekly_avg": weekly_avg,
            "is_terminal": "yes" if is_term else "",
            "routes": ",".join(sorted(routes)),
            "lat": g["lat"], "lon": g["lon"],
        }
        if len(shared) > 1:
            props["sharedModes"] = shared
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Point", "coordinates": [g["lon"], g["lat"]]},
        })

    gj = {"type": "FeatureCollection", "features": features}
    p_geo = out("stop.geojson")
    with open(p_geo, "w", encoding="utf-8") as f:
        json.dump(gj, f, ensure_ascii=False)
    print(f"OK -> {p_geo}  ({len(features)} stops)")

    obj = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "modes": mode_meta,
        "stats": stats,
    }
    p_info = out("stop_info.json")
    with open(p_info, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"OK -> {p_info}  ({len(stats)} record)")

    geo_ids = {ft["properties"]["stop_id"] for ft in features}
    info_ids = set(stats.keys())
    missing = geo_ids - info_ids
    print(f"[consistency] geojson={len(geo_ids)} info={len(info_ids)} without_info={len(missing)}")
    if missing:
        print("  WARNING: some stops without info:", list(missing)[:5])
    else:
        print("  All geojson stops have a record in stop_info -> OK")

    from collections import Counter
    dist = Counter(ft["properties"]["mode"] for ft in features)
    print("  stops per mode:", dict(dist))


if __name__ == "__main__":
    main()
