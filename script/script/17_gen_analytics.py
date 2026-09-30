# -*- coding: utf-8 -*-
import os
import sys
import json
import math
import csv
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P

OUT = P.out("analytics.json")


# --------------------------------------------------------------------------
# Reading helpers + 1:1 replicas of the frontend functions
# --------------------------------------------------------------------------
def load_features(path):
    """Returns the list of features of a GeoJSON, or [] if missing/unreadable."""
    if not os.path.exists(path):
        print("  [warn] missing:", os.path.relpath(path, P.OUTPUT_DIR))
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            gj = json.load(f)
    except Exception as e:
        print("  [warn] unreadable:", os.path.basename(path), e)
        return []
    feats = gj.get("features") if isinstance(gj, dict) else None
    return feats if isinstance(feats, list) else []


def num(x):
    """parseFloat like in the frontend: value or 0 if not numeric."""
    try:
        v = float(x)
        return 0.0 if math.isnan(v) else v
    except (TypeError, ValueError):
        return 0.0


def nums(feats, prop, map61=False):
    """
    Replica of this.nums(): extracts the numeric values of a property.
    map61=True -> the string value '> 60' becomes 61 (like in the frontend, used
    by the transport_stop field of the 15-min polygons).
    Skips undefined/None/'' values (like the frontend).
    """
    out = []
    for f in feats:
        raw = (f.get("properties") or {}).get(prop)
        if raw is None or raw == "":
            continue
        if map61 and raw == "> 60":
            out.append(61.0)
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isnan(v):
            out.append(v)
    return out


def bin_counts(vals, edges):
    """
    EXACT replica of this.binCounts(): counts the values in the bins defined by
    edges (right-half-open, the last one is inclusive on +inf). Returns a
    list of len(edges)-1 counts.
    """
    counts = [0] * (len(edges) - 1)
    for v in vals:
        for i in range(len(edges) - 1):
            if v >= edges[i] and (v < edges[i + 1] or i == len(edges) - 2):
                counts[i] += 1
                break
    return counts


def ring_area_m2(ring):
    """Area (m^2) of a lon/lat ring with shoelace, like the FE featureAreaM2."""
    if not ring or len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    m_lat = 111320.0
    m_lon = 111320.0 * math.cos(lat0 * math.pi / 180.0)
    a = 0.0
    for i in range(len(ring) - 1):
        x1 = ring[i][0] * m_lon
        y1 = ring[i][1] * m_lat
        x2 = ring[i + 1][0] * m_lon
        y2 = ring[i + 1][1] * m_lat
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def feature_area_m2(f):
    """Replica of this.featureAreaM2(): area of the polygonal feature (m^2)."""
    g = f.get("geometry") or {}
    coords = g.get("coordinates")
    if not coords:
        return 0.0
    tot = 0.0
    if g.get("type") == "Polygon":
        tot += ring_area_m2(coords[0])
    elif g.get("type") == "MultiPolygon":
        for poly in coords:
            tot += ring_area_m2(poly[0])
    return tot


def stops_bbox_area_km2(stops):
    lons, lats = [], []
    for f in stops:
        g = (f.get("geometry") or {})
        c = g.get("coordinates")
        if not c or len(c) < 2:
            continue
        try:
            lon = float(c[0]); lat = float(c[1])
        except (TypeError, ValueError):
            continue
        if math.isnan(lon) or math.isnan(lat):
            continue
        lons.append(lon); lats.append(lat)
    if len(lons) < 2 or len(lats) < 2:
        return 0.0
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)

    # rectangle -> EPSG:6933 (equal-area) -> area/1e6.
    try:
        import geopandas as gpd
        from shapely.geometry import box
        gs = gpd.GeoSeries(
            [box(min_lon, min_lat, max_lon, max_lat)], crs=4326
        )
        return float(gs.to_crs(6933).area.iloc[0] / 1e6)
    except Exception:
        pass

    lat_mid = (min_lat + max_lat) / 2.0
    m_lat = 111132.0
    m_lon = 111320.0 * math.cos(lat_mid * math.pi / 180.0)
    w_m = (max_lon - min_lon) * m_lon
    h_m = (max_lat - min_lat) * m_lat
    return abs(w_m * h_m) / 1e6


def stops_bbox_area_by_mode(stops, modes=("bus", "tram", "metro")):
    out = {}
    for md in modes:
        sub = [
            f for f in stops
            if str((f.get("properties") or {}).get("mode") or "").strip().lower() == md
        ]
        out[md] = stops_bbox_area_km2(sub)
    out["total"] = stops_bbox_area_km2(stops)
    return out


def fmt_num(n, decimals=0):

    if n is None or (isinstance(n, float) and (math.isinf(n) or math.isnan(n))):
        return "\u2014"
    return f"{n:,.{decimals}f}"


def is_night_route(r):
    """routes 4xx/5xx/6xx = night/regional (like the FE /^[456]\\d\\d/)."""
    r = str(r).strip()
    return len(r) >= 3 and r[0] in "456" and r[1].isdigit() and r[2].isdigit()


def total_area_km2():
    gpkg = P.data_any("lau_eurostat.gpkg")
    if not os.path.exists(gpkg):
        print("  [warn] missing LAU layer:", os.path.basename(gpkg))
        return None
    try:
        import geopandas as gpd
    except Exception as e:
        print("  [warn] geopandas not available for the LAU area:", e)
        return None
    try:
        gdf = gpd.read_file(gpkg)
    except Exception as e:
        print("  [warn] unable to read the LAU layer:", e)
        return None

    area_geom = None
    try:
        g = gdf.set_crs(4326) if gdf.crs is None else gdf
        area_geom = float(g.to_crs(6933).geometry.area.sum() / 1e6)
    except Exception as e:
        print("  [warn] LAU geometric area computation failed:", e)

    area_col = None
    for col in gdf.columns:
        if col.lower() == "area_km2":
            try:
                area_col = float(gdf[col].astype(float).sum())
            except Exception:
                area_col = None
            break

    if area_col is not None and area_col > 0:
        if area_geom and area_geom > 0:
            ratio = area_col / area_geom
            if 0.7 <= ratio <= 1.3:
                print(f"  LAU area from 'AREA_KM2' column (consistent): {area_col:.2f} km2")
                return area_col
            print(f"  [warn] AREA_KM2={area_col:.2f} column inconsistent with geometry "
                  f"({area_geom:.2f} km2, ratio {ratio:.1f}x) -> using the geometric one")
        else:
            print(f"  LAU area from 'AREA_KM2' column (no geom): {area_col:.2f} km2")
            return area_col

    if area_geom and area_geom > 0:
        print(f"  LAU geometric area (EPSG:6933): {area_geom:.2f} km2")
        return area_geom
    return None

_SEP_ROOT = os.path.join(P.ROOT_DIR, "data", "raw_data")

_MODE_FALLBACK = "bus"


def _parse_gtfs_date(s):
    """'YYYYMMDD' -> datetime.date, or None if invalid."""
    s = (s or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    try:
        return datetime.date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def service_active_dates(gtfs_dir):

    cal = os.path.join(gtfs_dir, "calendar.txt")
    cal_dates = os.path.join(gtfs_dir, "calendar_dates.txt")

    # Python weekday(): mon=0 .. sun=6; GTFS column order: monday..sunday.
    week_cols = ["monday", "tuesday", "wednesday", "thursday",
                 "friday", "saturday", "sunday"]

    # For each service_id: (start, end, [7 bool flags]) from calendar.txt.
    services = {}
    if os.path.exists(cal):
        try:
            with open(cal, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    sid = (r.get("service_id") or "").strip()
                    if not sid:
                        continue
                    start = _parse_gtfs_date(r.get("start_date"))
                    end = _parse_gtfs_date(r.get("end_date"))
                    if not start or not end:
                        continue
                    flags = []
                    for c in week_cols:
                        flags.append(str(r.get(c, "0")).strip() == "1")
                    services[sid] = (start, end, flags)
        except Exception as e:
            print("  [warn] calendar.txt unreadable:", gtfs_dir, e)

    dates = set()
    # Expand the weekly days of each service between start and end.
    for sid, (start, end, flags) in services.items():
        if end < start:
            continue
        d = start
        one = datetime.timedelta(days=1)
        while d <= end:
            if flags[d.weekday()]:
                dates.add(d)
            d += one

    # Apply the calendar_dates.txt exceptions.
    if os.path.exists(cal_dates):
        try:
            with open(cal_dates, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    dd = _parse_gtfs_date(r.get("date"))
                    if not dd:
                        continue
                    et = str(r.get("exception_type", "")).strip()
                    if et == "1":
                        dates.add(dd)      # service added on that date
                    elif et == "2":
                        pass
            # Second pass: remove the dates with ONLY exception 2 and no
            # other reason for activity (neither calendar nor exception 1).
            added = set()
            removed = set()
            with open(cal_dates, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    dd = _parse_gtfs_date(r.get("date"))
                    if not dd:
                        continue
                    et = str(r.get("exception_type", "")).strip()
                    if et == "1":
                        added.add(dd)
                    elif et == "2":
                        removed.add(dd)
            for dd in removed:
                # remove only if that date is not covered either by the weekly
                # calendar or by an explicit addition
                covered_by_cal = False
                for sid, (start, end, flags) in services.items():
                    if start <= dd <= end and flags[dd.weekday()]:
                        covered_by_cal = True
                        break
                if not covered_by_cal and dd not in added and dd in dates:
                    dates.discard(dd)
        except Exception as e:
            print("  [warn] calendar_dates.txt unreadable:", gtfs_dir, e)

    return dates


def _fmt_iso(d):
    """datetime.date -> 'YYYY-MM-DD' (or '\u2014' if None)."""
    return d.isoformat() if d else "\u2014"


def _fmt_ddmmyyyy(d):
    """datetime.date -> 'dd/mm/yyyy' (or '\u2014' if None)."""
    return d.strftime("%d/%m/%Y") if d else "\u2014"


def _fmt_date_range(start_d, end_d):

    if not start_d and not end_d:
        return "\u2014"
    return f"{_fmt_ddmmyyyy(start_d)} - {_fmt_ddmmyyyy(end_d)}"


def service_windows_by_mode(modes=("bus", "metro", "tram")):

    out = {}
    union = set()
    for md in modes:
        gtfs_dir = os.path.join(_SEP_ROOT, md)
        dates = service_active_dates(gtfs_dir) if os.path.isdir(gtfs_dir) else set()
        if dates:
            out[md] = {"start": min(dates), "end": max(dates), "days": len(dates)}
            union |= dates
        else:
            out[md] = {"start": None, "end": None, "days": 0}
    out["total"] = (
        {"start": min(union), "end": max(union), "days": len(union)}
        if union else {"start": None, "end": None, "days": 0}
    )
    return out


def _hhmmss_to_sec(s):
    """'HH:MM:SS' -> seconds (handles hours >23, e.g. 25:30:00). None if invalid."""
    try:
        parts = str(s).strip().split(":")
        if len(parts) != 3:
            return None
        h, m, sec = int(parts[0]), int(parts[1]), int(parts[2])
        return h * 3600 + m * 60 + sec
    except (TypeError, ValueError):
        return None


def _active_days_by_service(gtfs_dir):

    cal = os.path.join(gtfs_dir, "calendar.txt")
    cal_dates = os.path.join(gtfs_dir, "calendar_dates.txt")
    week_cols = ["monday", "tuesday", "wednesday", "thursday",
                 "friday", "saturday", "sunday"]
    dates_by_service = {}

    if os.path.exists(cal):
        try:
            with open(cal, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    sid = (r.get("service_id") or "").strip()
                    if not sid:
                        continue
                    start = _parse_gtfs_date(r.get("start_date"))
                    end = _parse_gtfs_date(r.get("end_date"))
                    if not start or not end or end < start:
                        continue
                    flags = [str(r.get(c, "0")).strip() == "1" for c in week_cols]
                    s = dates_by_service.setdefault(sid, set())
                    d = start
                    one = datetime.timedelta(days=1)
                    while d <= end:
                        if flags[d.weekday()]:
                            s.add(d)
                        d += one
        except Exception as e:
            print("  [warn] calendar.txt (per-service) unreadable:", gtfs_dir, e)

    if os.path.exists(cal_dates):
        try:
            with open(cal_dates, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    sid = (r.get("service_id") or "").strip()
                    dd = _parse_gtfs_date(r.get("date"))
                    if not sid or not dd:
                        continue
                    et = str(r.get("exception_type", "")).strip()
                    s = dates_by_service.setdefault(sid, set())
                    if et == "1":
                        s.add(dd)       # date added
                    elif et == "2":
                        s.discard(dd)   # date removed
        except Exception as e:
            print("  [warn] calendar_dates.txt (per-service) unreadable:", gtfs_dir, e)

    return {sid: len(dates) for sid, dates in dates_by_service.items()}


def _total_trips_in_period(gtfs_dir):

    trips_path = os.path.join(gtfs_dir, "trips.txt")
    freq_path = os.path.join(gtfs_dir, "frequencies.txt")
    if not os.path.exists(trips_path):
        return 0

    days_by_service = _active_days_by_service(gtfs_dir)

    # --- Read trips.txt: trip_id -> (route_id, service_id, shape_id, direction_id) ---
    trips = {}
    try:
        with open(trips_path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                tid = (r.get("trip_id") or "").strip()
                sid = (r.get("service_id") or "").strip()
                if not tid or not sid:
                    continue
                trips[tid] = {
                    "route_id": (r.get("route_id") or "").strip(),
                    "service_id": sid,
                    "shape_id": (r.get("shape_id") or "").strip(),
                    "direction_id": (r.get("direction_id") or "").strip(),
                }
    except Exception as e:
        print("  [warn] trips.txt unreadable:", gtfs_dir, e)
        return 0

    # --- CASE A: frequencies.txt populated ---
    freq_rows = []
    if os.path.exists(freq_path) and os.path.getsize(freq_path) > 0:
        try:
            with open(freq_path, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    tid = (r.get("trip_id") or "").strip()
                    if not tid or tid not in trips:
                        continue
                    st = _hhmmss_to_sec(r.get("start_time"))
                    en = _hhmmss_to_sec(r.get("end_time"))
                    try:
                        hw = float(r.get("headway_secs"))
                    except (TypeError, ValueError):
                        hw = 0.0
                    if st is None or en is None or hw <= 0 or en <= st:
                        continue
                    freq_rows.append((tid, r.get("start_time"), r.get("end_time"), hw, st, en))
        except Exception as e:
            print("  [warn] frequencies.txt unreadable:", gtfs_dir, e)
            freq_rows = []

    if freq_rows:

        seen = set()
        total = 0
        for (tid, st_str, en_str, hw, st, en) in freq_rows:
            t = trips[tid]
            key = (t["route_id"], t["shape_id"], t["service_id"],
                   st_str, en_str, hw, t["direction_id"])
            if key in seen:
                continue
            seen.add(key)
            corse_gg = math.ceil((en - st) / hw)
            giorni = days_by_service.get(t["service_id"], 0)
            total += corse_gg * giorni
        return int(total)

    # --- CASE B: no valid frequency -> each trip = 1 trip/day ---
    total = 0
    for tid, t in trips.items():
        total += days_by_service.get(t["service_id"], 0)
    return int(total)


def daily_trips_by_mode(modes=("bus", "metro", "tram")):

    out = {}
    for md in modes:
        gtfs_dir = os.path.join(_SEP_ROOT, md)
        out[md] = _total_trips_in_period(gtfs_dir) if os.path.isdir(gtfs_dir) else 0
    return out


def _haversine_km(lat1, lon1, lat2, lon2):
    """Geodetic distance (km) between two lat/lon points (haversine formula)."""
    R = 6371.0088
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _shape_lengths_km(gtfs_dir):

    path = os.path.join(gtfs_dir, "shapes.txt")
    if not os.path.exists(path):
        return {}
    pts = {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                sid = (r.get("shape_id") or "").strip()
                if not sid:
                    continue
                try:
                    lat = float(r.get("shape_pt_lat"))
                    lon = float(r.get("shape_pt_lon"))
                    seq = int(float(r.get("shape_pt_sequence")))
                except (TypeError, ValueError):
                    continue
                pts.setdefault(sid, []).append((seq, lat, lon))
    except Exception as e:
        print("  [warn] shapes.txt unreadable:", gtfs_dir, e)
        return {}

    lengths = {}
    for sid, arr in pts.items():
        arr.sort(key=lambda t: t[0])
        tot = 0.0
        for i in range(len(arr) - 1):
            tot += _haversine_km(arr[i][1], arr[i][2], arr[i + 1][1], arr[i + 1][2])
        lengths[sid] = tot
    return lengths


def _revenue_km_in_period(gtfs_dir):

    trips_path = os.path.join(gtfs_dir, "trips.txt")
    freq_path = os.path.join(gtfs_dir, "frequencies.txt")
    if not os.path.exists(trips_path):
        return 0.0

    days_by_service = _active_days_by_service(gtfs_dir)
    shape_len_km = _shape_lengths_km(gtfs_dir)

    trips = {}
    try:
        with open(trips_path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                tid = (r.get("trip_id") or "").strip()
                sid = (r.get("service_id") or "").strip()
                if not tid or not sid:
                    continue
                trips[tid] = {
                    "route_id": (r.get("route_id") or "").strip(),
                    "service_id": sid,
                    "shape_id": (r.get("shape_id") or "").strip(),
                    "direction_id": (r.get("direction_id") or "").strip(),
                }
    except Exception as e:
        print("  [warn] trips.txt unreadable (revenue-km):", gtfs_dir, e)
        return 0.0

    # --- CASE A: frequencies.txt populated ---
    freq_rows = []
    if os.path.exists(freq_path) and os.path.getsize(freq_path) > 0:
        try:
            with open(freq_path, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    tid = (r.get("trip_id") or "").strip()
                    if not tid or tid not in trips:
                        continue
                    st = _hhmmss_to_sec(r.get("start_time"))
                    en = _hhmmss_to_sec(r.get("end_time"))
                    try:
                        hw = float(r.get("headway_secs"))
                    except (TypeError, ValueError):
                        hw = 0.0
                    if st is None or en is None or hw <= 0 or en <= st:
                        continue
                    freq_rows.append((tid, r.get("start_time"), r.get("end_time"), hw, st, en))
        except Exception as e:
            print("  [warn] frequencies.txt unreadable (revenue-km):", gtfs_dir, e)
            freq_rows = []

    if freq_rows:
        seen = set()
        total_km = 0.0
        for (tid, st_str, en_str, hw, st, en) in freq_rows:
            t = trips[tid]
            key = (t["route_id"], t["shape_id"], t["service_id"],
                   st_str, en_str, hw, t["direction_id"])
            if key in seen:
                continue
            seen.add(key)
            corse_gg = math.ceil((en - st) / hw)
            giorni = days_by_service.get(t["service_id"], 0)
            length = shape_len_km.get(t["shape_id"], 0.0)
            total_km += length * corse_gg * giorni
        return float(total_km)

    # --- CASE B: no valid frequency -> each trip = 1 trip/day ---
    total_km = 0.0
    for tid, t in trips.items():
        giorni = days_by_service.get(t["service_id"], 0)
        length = shape_len_km.get(t["shape_id"], 0.0)
        total_km += length * giorni
    return float(total_km)


def revenue_km_by_mode(modes=("bus", "metro", "tram")):
    """
    Returns, for each mode, the TOTAL revenue-km in the period (km driven by the
    vehicles), from the separated raw GTFS. city-agnostic: if the GTFS is missing -> 0.0.
    """
    out = {}
    for md in modes:
        gtfs_dir = os.path.join(_SEP_ROOT, md)
        out[md] = _revenue_km_in_period(gtfs_dir) if os.path.isdir(gtfs_dir) else 0.0
    return out

def _agency_info(gtfs_dir):

    path = os.path.join(gtfs_dir, "agency.txt")
    empty = {"id": "", "name": "", "url": "", "count": 0}
    if not os.path.exists(path):
        return dict(empty)
    # Preserve the order of appearance but deduplicate by agency_id.
    ids = []
    id2name = {}
    id2url = {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                aid = (r.get("agency_id") or "").strip()
                aname = (r.get("agency_name") or "").strip()
                aurl = (r.get("agency_url") or "").strip()
                # uniqueness key: agency_id if present, otherwise the name
                key = aid if aid else aname
                if not key:
                    continue
                if key not in id2name:
                    ids.append(key)
                    # if agency_id is empty, still show the name as "id"
                    id2name[key] = aname or key
                    id2url[key] = aurl
    except Exception as e:
        print("  [warn] agency.txt unreadable:", gtfs_dir, e)
        return dict(empty)

    if not ids:
        return dict(empty)

    count = len(ids)
    if count == 1:
        disp_id = ids[0]
        disp_name = id2name[ids[0]] or ids[0]
        # single agency: use its agency_url (direct clickable link)
        disp_url = id2url.get(ids[0], "") or ""
    else:

        disp_id = str(count)
        disp_name = " | ".join(id2name[k] for k in ids)
        disp_url = next((id2url[k] for k in ids if id2url.get(k)), "") or ""
    return {"id": disp_id, "name": disp_name, "url": disp_url, "count": count}


def agencies_by_mode(modes=("bus", "metro", "tram")):

    out = {}
    for md in modes:
        gtfs_dir = os.path.join(_SEP_ROOT, md)
        out[md] = _agency_info(gtfs_dir) if os.path.isdir(gtfs_dir) else {"id": "", "name": "", "url": "", "count": 0}
    return out

def _jenks_breaks_generic(vals, k=5):

    try:
        import numpy as np
        data = np.asarray([float(x) for x in vals], dtype="float64")
        data = data[np.isfinite(data)]
    except Exception:
        # without numpy: work on a pure python list
        data = [float(x) for x in vals]
    n = len(data)
    if n == 0:
        return [], "empty"
    try:
        import jenkspy
        import numpy as np
        d = data
        if getattr(d, "size", len(d)) > 200000:
            idx = np.random.RandomState(42).choice(d.size, 200000, replace=False)
            d = d[idx]
        d_list = d.tolist() if hasattr(d, "tolist") else list(d)
        # jenkspy requires at least k distinct values for k classes
        if len(set(d_list)) < k:
            k_eff = max(1, len(set(d_list)))
        else:
            k_eff = k
        breaks = jenkspy.jenks_breaks(d_list, n_classes=k_eff)
        return list(breaks), "jenks"
    except Exception as e:
        print("  [warn] jenkspy not available/error for desDist "
              f"({e}) -> using quantiles as fallback")
        try:
            import numpy as np
            qs = np.linspace(0, 100, k + 1)
            breaks = list(np.percentile(data, qs))
            return breaks, "quantili_fallback"
        except Exception:
            # pure-python fallback: raw quantiles
            s = sorted(float(x) for x in vals)
            m = len(s)
            if m == 0:
                return [], "empty"
            breaks = [s[min(m - 1, int(round(i * (m - 1) / k)))] for i in range(k + 1)]
            return breaks, "quantili_fallback"


def desert_dist_bins(desert_pops, k=5):

    vals = [float(x) for x in desert_pops if float(x) > 0]
    if len(vals) < 2 or len(set(round(v) for v in vals)) < 2:
        # insufficient data: static fallback (last bin is still "X-max")
        vmax = int(round(max(vals))) if vals else 21
        vmax = max(vmax, 21)
        return (["1-2", "3-5", "6-10", "11-20", f"21-{vmax}"],
                [1, 3, 6, 11, 21, float(vmax) + 0.001])

    breaks, _metodo = _jenks_breaks_generic(vals, k)
    if not breaks or len(breaks) < 2:
        vmax = int(round(max(vals)))
        vmax = max(vmax, 21)
        return (["1-2", "3-5", "6-10", "11-20", f"21-{vmax}"],
                [1, 3, 6, 11, 21, float(vmax) + 0.001])

    # Round the breaks to integers and ensure strict monotonicity (like step 7).
    b = [int(round(x)) for x in breaks]
    for i in range(1, len(b)):
        if b[i] <= b[i - 1]:
            b[i] = b[i - 1] + 1
    vmin = int(round(min(vals)))
    vmax = int(round(max(vals)))
    b[0] = vmin
    b[-1] = max(vmax, b[-2] + 1)

    kk = len(b) - 1  # number of effective classes

    edges = [float(b[0])]
    for i in range(1, kk):
        edges.append(float(b[i]) + 1.0)  # start of next bin = b[i]+1
    edges.append(float(b[-1]) + 0.001)   # last edge inclusive on the max

    labels = []
    for i in range(kk):
        lo = b[0] if i == 0 else b[i] + 1
        hi = b[i + 1]
        if lo > hi:
            hi = lo
        labels.append(f"{lo}-{hi}")   # the last one is also "start-max"
    return labels, edges


def lines_count_bins(stops, k=5):

    vals = [float(x) for x in nums(stops, "lines_count") if float(x) > 0]
    if len(vals) < 2 or len(set(round(v) for v in vals)) < 2:
        vmax = int(round(max(vals))) if vals else 8
        vmax = max(vmax, 8)
        return (["1", "2", "3-4", "5-7", f"8-{vmax}"],
                [0, 2, 3, 5, 8, float(vmax) + 0.001])

    breaks, _metodo = _jenks_breaks_generic(vals, k)
    if not breaks or len(breaks) < 2:
        vmax = int(round(max(vals)))
        vmax = max(vmax, 8)
        return (["1", "2", "3-4", "5-7", f"8-{vmax}"],
                [0, 2, 3, 5, 8, float(vmax) + 0.001])

    # Round to integers + strict monotonicity (like step 7 heatmap).
    b = [int(round(x)) for x in breaks]
    for i in range(1, len(b)):
        if b[i] <= b[i - 1]:
            b[i] = b[i - 1] + 1
    vmin = int(round(min(vals)))
    vmax = int(round(max(vals)))
    b[0] = vmin
    b[-1] = max(vmax, b[-2] + 1)

    kk = len(b) - 1
    edges = [float(b[0])]
    for i in range(1, kk):
        edges.append(float(b[i]) + 1.0)
    edges.append(float(b[-1]) + 0.001)

    labels = []
    for i in range(kk):
        lo = b[0] if i == 0 else b[i] + 1
        hi = b[i + 1]
        if lo > hi:
            hi = lo
        # if lo==hi the bin is a single value -> label "N", otherwise "lo-hi"
        labels.append(f"{lo}" if lo == hi else f"{lo}-{hi}")
    return labels, edges


# --------------------------------------------------------------------------
# Building the analytics blocks (1:1 with the frontend builders)
# --------------------------------------------------------------------------
def build_kpi(lines, stops, deserts, coverage, polys,
              area_tot_km2=None, windows=None, trips_by_mode=None,
              km_by_mode=None, pop_tot_override=None, pop_uncovered_override=None):
   
    unique_routes = len({
        (_line_mode(f), str((f.get("properties") or {}).get("line")))
        for f in lines
    })
    # Stops
    total_stops = len(stops)
    # Total population (from the coverage dataset, 'pop' field) and uncovered
    # (sum of 'pop_uncovered' over ALL coverage cells, not just the deserts)
    pop_tot = sum(num((f.get("properties") or {}).get("pop")) for f in coverage)
    pop_uncovered = sum(num((f.get("properties") or {}).get("pop_uncovered")) for f in coverage)
    
    if pop_tot_override is not None and (not coverage or pop_tot == 0):
        pop_tot = float(pop_tot_override)
    if pop_uncovered_override is not None and (not coverage or pop_uncovered == 0):
        pop_uncovered = float(pop_uncovered_override)
    # Network area (stops bbox): only used as a fallback for stop density.
    net_by_mode = stops_bbox_area_by_mode(stops, modes=("bus", "tram", "metro"))
    net_area_km2 = net_by_mode["total"]

    # The WHOLE municipality area (Total area LAU), fallback to network area.
    density_area = area_tot_km2 if (area_tot_km2 and area_tot_km2 > 0) else net_area_km2
    stop_density = (total_stops / density_area) if density_area else 0.0


    windows = windows or {}
    trips_by_mode = trips_by_mode or {}
    km_by_mode = km_by_mode or {}
    avg_km_day = 0.0
    avg_trip_day = 0.0
    for md in ("bus", "metro", "tram"):
    
        km_md = float(km_by_mode.get(md) or 0.0)
        trip_md = int((trips_by_mode.get(md) or 0))
        days_md = int((windows.get(md) or {}).get("days") or 0)
        if days_md > 0:
            avg_km_day += km_md / days_md
            avg_trip_day += trip_md / days_md
        # if the mode has no window (0 days) it does not contribute to the daily avg
    total_lines = unique_routes    # total service lines

    kpi = []
    # "Total area" only for the TOTAL (at the top), if available from the LAU layer
    if area_tot_km2 is not None:
        kpi.append(
            {"label": "Total area",   "value": fmt_num(area_tot_km2, 0),  "unit": "km\u00b2"}
        )
    kpi.extend([
        {"label": "Total stops",   "value": fmt_num(total_stops),      "unit": ""},
        {"label": "Stop density",  "value": fmt_num(stop_density, 1),  "unit": "stops/km\u00b2"},
        {"label": "Avg km/day",    "value": fmt_num(avg_km_day),       "unit": "km"},
        {"label": "Avg trip/day",  "value": fmt_num(avg_trip_day),     "unit": "trips"},
        {"label": "Total lines",   "value": fmt_num(total_lines),      "unit": ""},
        {"label": "Pop tot",       "value": fmt_num(pop_tot),          "unit": "inhab."},
        {"label": "Pop uncovered", "value": fmt_num(pop_uncovered),    "unit": "inhab."},
    ])
    return kpi


def _line_mode(f):
    """Transport mode of a line-feature from the 'transit_type' field
    (0=tram, 1=metro, 3=bus). Fallback 'bus' for unrecognized values,
    like the frontend transitTypeToMode()."""
    raw = (f.get("properties") or {}).get("transit_type")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return "bus"
    if n == 0:
        return "tram"
    if n == 1:
        return "metro"
    if n == 3:
        return "bus"
    return "bus"


def _stop_mode(f):
    """Transport mode of a stop from the 'mode' field (bus/metro/tram)."""
    return str((f.get("properties") or {}).get("mode") or "").strip().lower()


def build_kpi_by_mode(lines, stops, area_tot_km2=None,
                      modes=("bus", "metro", "tram"), windows=None,
                      trips_by_mode=None, km_by_mode=None, ag_by_mode=None):

    windows = windows or {}
    trips_by_mode = trips_by_mode or {}
    km_by_mode = km_by_mode or {}
    ag_by_mode = ag_by_mode or {}
    labels = [
        "Total stops", "Stop density", "Avg km/day", "Avg trip/day", "Total lines",
        "Date range", "Agencies",
    ]
    rows = []
    for md in modes:
        mlines = [f for f in lines if _line_mode(f) == md]
        mstops = [f for f in stops if _stop_mode(f) == md]
        # if the mode has neither lines nor stops, skip it (not present in the city)
        if not mlines and not mstops:
            continue


        total_km = float(km_by_mode.get(md) or 0.0)
        unique_routes = len({str((f.get("properties") or {}).get("line")) for f in mlines})
        total_lines = unique_routes

        total_trips = int((trips_by_mode.get(md) or 0))
        total_stops = len(mstops)

        agencies = (ag_by_mode.get(md) or {})
        if not isinstance(agencies, dict):
            # backward compatibility if ag_by_mode were still a simple count
            agencies = {"id": fmt_num(int(agencies or 0)), "name": "", "url": "", "count": int(agencies or 0)}
        net_area_km2 = stops_bbox_area_km2(mstops)

        density_area = area_tot_km2 if (area_tot_km2 and area_tot_km2 > 0) else net_area_km2
        stop_density = (total_stops / density_area) if density_area else 0.0

        # ---- Time span of the MODE (effective days) ----
        win = windows.get(md) or {}
        days = int(win.get("days") or 0)
        start_d = win.get("start")
        end_d = win.get("end")
        # Daily averages of the mode: divide by the days of the MODE's span.
        avg_km_day = (total_km / days) if days > 0 else total_km
        avg_trip_day = (total_trips / days) if days > 0 else total_trips

        cells = [
            {"label": "Total stops",   "value": fmt_num(total_stops),     "unit": ""},
            {"label": "Stop density",  "value": fmt_num(stop_density, 1), "unit": "stops/km\u00b2"},
            {"label": "Avg km/day",    "value": fmt_num(avg_km_day),      "unit": "km"},
            {"label": "Avg trip/day",  "value": fmt_num(avg_trip_day),    "unit": "trips"},
            {"label": "Total lines",   "value": fmt_num(total_lines),     "unit": ""},

            {"label": "Date range",    "value": _fmt_date_range(start_d, end_d), "unit": ""},

            {"label": "Agencies",      "value": (agencies.get("id") or "\u2014"),
             "tooltip": (agencies.get("name") or ""),
             "url": (agencies.get("url") or ""),                          "unit": ""},
        ]
        rows.append({"mode": md, "cells": cells})

    return {"labels": labels, "rows": rows}


def build_charts(lines, stops, desert_pops, coverage, polys):
    """
    For each chart it builds { labels, data } (or dedicated structures for the
    'focus' charts with tooltip). The KEYS are 'section__chartid', identical
    to the data-cid of the Angular template, so the frontend picks them directly.

    NB (cleanup B 2026-09-08): 'desert_pops' is NO LONGER a list of geojson
    features, but directly the LIST of 'pop' values of the desert-pixels read
    from transit_desert.tif (see desert_pops_from_tif()).
    """
    charts = {}

    # ---- 1) TRANSPORT (transport_stop = minutes) ----
    v = nums(polys, "transport_stop", map61=True)
    charts["transport__dist"] = {
        "labels": ["<5", "5\u201310", "10\u201315", "15\u201330", ">30"],
        "data": bin_counts(v, [0, 5, 10, 15, 30, float("inf")]),
    }
    charts["transport__zones"] = {
        "labels": ["< 15 min", "15\u201330 min", "30\u201360 min", "> 60 min"],
        "data": bin_counts(v, [0, 15, 30, 60, float("inf")]),
    }
    # Cumulative accessibility: % area reachable within X minutes
    vs = sorted(v)
    n = len(vs) or 1
    thresholds = [5, 10, 15, 20, 30, 45, 60]
    cum = [round(len([x for x in vs if x <= t]) / n * 100.0, 1) for t in thresholds]
    charts["transport__cumul"] = {
        "labels": [f"{t}m" for t in thresholds],
        "data": cum,
    }

    byl_labels, byl_edges = lines_count_bins(stops, k=5)
    charts["stops__byLines"] = {
        "labels": byl_labels,
        "data": bin_counts(nums(stops, "lines_count"), byl_edges),
    }
    term = sum(
        1 for f in stops
        if str((f.get("properties") or {}).get("is_terminal") or "").strip().lower() == "yes"
    )
    charts["stops__role"] = {
        "labels": ["Terminal stop", "Through stop"],
        "data": [term, len(stops) - term],
    }
    urban = mixed = night = 0
    for f in stops:
        routes = [r.strip() for r in str((f.get("properties") or {}).get("routes") or "").split(",") if r.strip()]
        if not routes:
            continue
        has_n = any(is_night_route(r) for r in routes)
        has_u = any(not is_night_route(r) for r in routes)
        if has_n and has_u:
            mixed += 1
        elif has_n:
            night += 1
        else:
            urban += 1
    charts["stops__service"] = {
        "labels": ["Urban only", "Urban + regional", "Regional / night"],
        "data": [urban, mixed, night],
    }
    # Top 10 interchange hubs (per stop_id): keep name/stopId/n for the tooltip
    hubs = [{
        "name": str((f.get("properties") or {}).get("name") or "\u2014"),
        "stopId": str((f.get("properties") or {}).get("stop_id") or "\u2014"),
        "n": int(num((f.get("properties") or {}).get("lines_count"))),
    } for f in stops]
    hubs.sort(key=lambda a: a["n"], reverse=True)
    top = list(reversed(hubs[:10]))  # reverse like in the FE (horizontal bars)
    charts["stops__topHubs"] = {
        "labels": [a["name"] for a in top],
        "data": [a["n"] for a in top],
        "stopIds": [a["stopId"] for a in top],
    }

    # ---- 3) TRANSPORT LINES ----
    dv = nums(lines, "direction")
    out_dir = len([x for x in dv if x == 0])
    charts["lines__dir"] = {
        "labels": ["Outbound", "Inbound"],
        "data": [out_dir, len(dv) - out_dir],
    }
    # Top destinations (destination count, top 8, reverse)
    cnt = {}
    for f in lines:
        d = str((f.get("properties") or {}).get("destination") or "\u2014")
        cnt[d] = cnt.get(d, 0) + 1
    dest_sorted = sorted(cnt.items(), key=lambda kv: kv[1], reverse=True)[:8]
    dest_sorted = list(reversed(dest_sorted))
    charts["lines__dest"] = {
        "labels": [k for k, _ in dest_sorted],
        "data": [val for _, val in dest_sorted],
    }

    # ---- 4) HEATMAP FREQUENCY (frequency per segment) ----
    fv = nums(lines, "frequency")
    freq_bins = bin_counts(fv, [1, 11, 41, 81, 151, float("inf")])
    charts["freq__distFreq"] = {
        "labels": ["1\u201310", "11\u201340", "41\u201380", "81\u2013150", ">150"],
        "data": freq_bins,
    }
    charts["freq__classShare"] = {
        "labels": ["Low", "Moderate", "High", "Very High", "Major corridor"],
        "data": freq_bins,
    }

    cv = nums(coverage, "pct_covered")
    if not cv:
        cv = coverage_pct_from_tif("pop_coverage_map.tif")
    charts["coverage__covDist"] = {
        "labels": ["0%", "1\u201325%", "25\u201350%", "50\u201375%", "75\u2013100%"],
        "data": bin_counts(cv, [0, 0.001, 25, 50, 75, 100.001]),
    }
    well = len([x for x in cv if x >= 75])
    partial = len([x for x in cv if 0 < x < 75])
    none_c = len([x for x in cv if x == 0])
    charts["coverage__covShare"] = {
        "labels": ["Well served (\u226575%)", "Partly served", "Not served (0%)"],
        "data": [well, partial, none_c],
    }

    dist_labels, dist_edges = desert_dist_bins(desert_pops, k=5)
    charts["deserts__desDist"] = {
        "labels": dist_labels,
        "data": bin_counts(desert_pops, dist_edges),
    }
    desert_pop = sum(desert_pops)
    total_pop = sum(nums(coverage, "pop"))
    pop_uncovered = sum(nums(coverage, "pop_uncovered"))
    served = max(total_pop - pop_uncovered, 0)
    unserved_outside = max(pop_uncovered - desert_pop, 0)
    charts["deserts__desServed"] = {
        "labels": [
            "Served residents",
            "Unserved residents",
            ["Unserved residents", "in transit desert"],
        ],
        # round to integers: they are resident counts (Chart.js shows them as such) (accounting for the uncovered of population coverage)
        "data": [round(served), round(unserved_outside), round(desert_pop)],
    }

    return charts


def first_existing(*names):
    """Returns the first existing file among the passed names (in output/), or the
    first name anyway (for the warn message). Needed because the names of the
    files in output/ differ from those in the assets:
      coverage -> 'population_coverage.geojson' (output) vs 'pop_coverage_map.geojson' (assets)
      deserts  -> 'transit_desert.geojson'      (output) vs 'transit_deserts.geojson'  (assets)
    """
    for n in names:
        p = P.out(n)
        if os.path.exists(p):
            return p
    return P.out(names[0])


def desert_pops_from_tif(tif_name="transit_desert.tif"):
   
    path = P.out(tif_name)
    if not os.path.exists(path):
        print("  [warn] missing:", tif_name, "(deserts from tif) -> empty list")
        return []
    try:
        import rasterio
        import numpy as np
        with rasterio.open(path) as ds:
            nodata = ds.nodata if ds.nodata is not None else -1.0
            pop = ds.read(2).astype("float64")  # band 2 = pop
        vals = pop[(pop != nodata)]
        # keep only pixels with pop > 0 (consistent with the desert rule pop>0)
        return [float(x) for x in vals[vals > 0]]
    except Exception as e:
        print("  [warn] reading transit_desert.tif failed:", e, "-> empty list")
        return []


def coverage_pop_from_tif(tif_name="pop_coverage_map.tif"):
  
    path = P.out(tif_name)
    if not os.path.exists(path):
        print("  [warn] missing:", tif_name, "(coverage from tif) -> using geojson if present")
        return (None, None)
    try:
        import rasterio
        import numpy as np
        with rasterio.open(path) as ds:
            nbands = ds.count
            nodata = ds.nodata
            pop_tot_band = ds.read(2).astype("float64")     # band 2 = pop_tot
            if nbands >= 4:
                pop_unc_band = ds.read(4).astype("float64")  # band 4 = pop_uncovered
            else:
                pop_unc_band = None
        if nodata is not None:
            pt = float(pop_tot_band[pop_tot_band != nodata].sum())
            pu = (float(pop_unc_band[pop_unc_band != nodata].sum())
                  if pop_unc_band is not None else None)
        else:
            # without declared nodata, exclude the negative (sentinel) values
            pt = float(pop_tot_band[pop_tot_band >= 0].sum())
            pu = (float(pop_unc_band[pop_unc_band >= 0].sum())
                  if pop_unc_band is not None else None)
        print(f"  coverage from tif {tif_name}: pop_tot={pt:,.0f} "
              f"pop_uncovered={('%.0f' % pu) if pu is not None else '—'}")
        return (pt, pu)
    except Exception as e:
        print("  [warn] reading pop_coverage_map.tif failed:", e, "-> using geojson if present")
        return (None, None)


def coverage_pct_from_tif(tif_name="pop_coverage_map.tif"):
   
    path = P.out(tif_name)
    if not os.path.exists(path):
        print("  [warn] missing:", tif_name, "(coverage pct from tif) -> empty list")
        return []
    try:
        import rasterio
        import numpy as np
        with rasterio.open(path) as ds:
            nodata = ds.nodata
            pct = ds.read(1).astype("float64")  # band 1 = pct_covered
        if nodata is not None:
            vals = pct[pct != nodata]
        else:
            # without declared nodata, exclude the negative (sentinel) values
            vals = pct[pct >= 0]
        return [float(x) for x in vals]
    except Exception as e:
        print("  [warn] reading pct_covered from tif failed:", e, "-> empty list")
        return []


def main():
    print("STEP 08e \u00b7 Generating output/analytics.json (KPI + precomputed charts)")

    lines    = load_features(P.out("line.geojson"))
    stops    = load_features(P.out("stop.geojson"))
    polys    = load_features(P.out("transport_15min.geojson"))
    # coverage: in output/ the name is population_coverage; keep the asset
    # name as a fallback for compatibility.
    coverage = load_features(first_existing("population_coverage.geojson", "pop_coverage_map.geojson"))
    
    desert_pops = desert_pops_from_tif("transit_desert.tif")

    print(f"  features read: lines={len(lines)} stops={len(stops)} "
          f"polys={len(polys)} coverage={len(coverage)} desert_pixels={len(desert_pops)}")

    # Total municipality area from the Eurostat LAU layer (data/lau_eurostat.gpkg)
    area_tot_km2 = total_area_km2()

    windows = service_windows_by_mode(modes=("bus", "metro", "tram"))
    days_total = int((windows.get("total") or {}).get("days") or 0)
    tw = windows.get("total") or {}
    print("  service time span (total): "
          f"{_fmt_iso(tw.get('start'))} -> {_fmt_iso(tw.get('end'))} "
          f"= {days_total} effective days")
    for _md in ("bus", "metro", "tram"):
        _w = windows.get(_md) or {}
        print(f"    {_md}: {_fmt_iso(_w.get('start'))} -> {_fmt_iso(_w.get('end'))} "
              f"= {int(_w.get('days') or 0)} days")

    trips_by_mode = daily_trips_by_mode(modes=("bus", "metro", "tram"))
    print("  total passes (trips) per mode from the raw GTFS: "
          f"bus={trips_by_mode.get('bus', 0):,} "
          f"metro={trips_by_mode.get('metro', 0):,} "
          f"tram={trips_by_mode.get('tram', 0):,}")

    km_by_mode = revenue_km_by_mode(modes=("bus", "metro", "tram"))
    print("  total revenue-km per mode from the raw GTFS: "
          f"bus={km_by_mode.get('bus', 0.0):,.0f} "
          f"metro={km_by_mode.get('metro', 0.0):,.0f} "
          f"tram={km_by_mode.get('tram', 0.0):,.0f}")
    
    ag_by_mode = agencies_by_mode(modes=("bus", "metro", "tram"))
    print("  agencies per mode from the raw GTFS: "
          f"bus={ag_by_mode.get('bus', 0)} "
          f"metro={ag_by_mode.get('metro', 0)} "
          f"tram={ag_by_mode.get('tram', 0)}")

    pop_tot_tif, pop_uncovered_tif = coverage_pop_from_tif("pop_coverage_map.tif")

    analytics = {
        # schema version, useful to invalidate any future caches
        "schema": 1,
       
        "kpi": build_kpi(lines, stops, None, coverage, polys, area_tot_km2,
                         windows=windows, trips_by_mode=trips_by_mode,
                         km_by_mode=km_by_mode,
                         pop_tot_override=pop_tot_tif,
                         pop_uncovered_override=pop_uncovered_tif),
        
        "kpi_by_mode": build_kpi_by_mode(lines, stops, area_tot_km2, windows=windows,
                                         trips_by_mode=trips_by_mode,
                                         km_by_mode=km_by_mode,
                                         ag_by_mode=ag_by_mode),
        "charts": build_charts(lines, stops, desert_pops, coverage, polys),
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(analytics, f, ensure_ascii=False)

    kb = round(os.path.getsize(OUT) / 1024, 1)
    print("  KPIs computed:", len(analytics["kpi"]),
          "| KPI by mode:", len(analytics.get("kpi_by_mode", {}).get("rows", [])),
          "| charts:", len(analytics["charts"]))
    print("OK ->", OUT, "|", kb, "KB")


if __name__ == "__main__":
    main()
