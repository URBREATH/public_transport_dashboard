# -*- coding: utf-8 -*-
import csv
import os
import json
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw_data")
OUT = os.path.join(HERE, "..", "output")
os.makedirs(OUT, exist_ok=True)

GIORNI = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

# Known modes (stable order). Only the ones whose folder exists are used.
MODI = ["bus", "metro", "tram"]


def scopri_cartelle_modo():
    """Returns a list of (mode, folder_path) for each modal subfolder
    existing in RAW. If none exists, returns [("_flat", RAW)] as a
    fallback on the old flat layout (the .txt files directly in raw_data/).
    """
    trovate = []
    for m in MODI:
        p = os.path.join(RAW, m)
        if os.path.isdir(p):
            trovate.append((m, p))
    # any other unexpected subfolders but with a trips.txt inside
    if os.path.isdir(RAW):
        for nome in sorted(os.listdir(RAW)):
            p = os.path.join(RAW, nome)
            if (os.path.isdir(p) and nome not in MODI
                    and os.path.exists(os.path.join(p, "trips.txt"))):
                trovate.append((nome, p))
    if not trovate:
        # fallback: historical flat layout
        trovate = [("_flat", RAW)]
    return trovate


def hhmmss_to_sec(s):
    s = (s or "").strip()
    if not s:
        return None
    p = s.split(":")
    try:
        h = int(p[0]); m = int(p[1]); sec = int(p[2]) if len(p) > 2 else 0
    except (ValueError, IndexError):
        return None
    return h * 3600 + m * 60 + sec


def parse_ymd(s):
    s = (s or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def build_service_calendar(base):
    """Like the original, but on a single 'base' folder (one mode).
       Returns:
       - service_days: dict service_id -> number of REAL days it is active
       - service_active: dict service_id -> True if active at least one day
       - active_dates: set of the dates (date) on which at least one service is active
       Robust to calendar.txt / calendar_dates.txt present or absent.
    """
    cal_path = os.path.join(base, "calendar.txt")
    caldates_path = os.path.join(base, "calendar_dates.txt")

    # exceptions: service_id -> { date: exception_type(1|2) }
    exceptions = {}
    if os.path.exists(caldates_path):
        with open(caldates_path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                sid = row.get("service_id")
                d = parse_ymd(row.get("date"))
                if sid is None or d is None:
                    continue
                try:
                    et = int(row.get("exception_type", "1"))
                except ValueError:
                    et = 1
                exceptions.setdefault(sid, {})[d] = et

    service_days = {}
    days_with_service = set()

    if os.path.exists(cal_path):
        rows = []
        with open(cal_path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                rows.append(row)

        # global range of the feed
        starts = [parse_ymd(r.get("start_date")) for r in rows]
        ends = [parse_ymd(r.get("end_date")) for r in rows]
        starts = [d for d in starts if d]
        ends = [d for d in ends if d]
        if starts and ends:
            gstart, gend = min(starts), max(ends)
        else:
            gstart = gend = None

        # for each service, precompute weekday-mask + range
        svc = []
        for r in rows:
            sid = r.get("service_id")
            if sid is None:
                continue
            mask = [r.get(g, "0") == "1" for g in GIORNI]  # mon..sun
            s = parse_ymd(r.get("start_date"))
            e = parse_ymd(r.get("end_date"))
            svc.append((sid, mask, s, e))
            service_days.setdefault(sid, 0)

        if gstart and gend and (gend - gstart).days <= 3660:  # guard ~10 years
            d = gstart
            while d <= gend:
                wd = d.weekday()  # 0=mon
                any_service_today = False
                for sid, mask, s, e in svc:
                    active = False
                    if s and e and s <= d <= e:
                        active = mask[wd]
                    # apply calendar_dates exceptions
                    ex = exceptions.get(sid, {}).get(d)
                    if ex == 1:
                        active = True
                    elif ex == 2:
                        active = False
                    if active:
                        service_days[sid] = service_days.get(sid, 0) + 1
                        any_service_today = True
                if any_service_today:
                    days_with_service.add(d)
                d += timedelta(days=1)
        else:
            # fallback: no valid range -> use only calendar_dates
            for sid, exmap in exceptions.items():
                for d, et in exmap.items():
                    if et == 1:
                        service_days[sid] = service_days.get(sid, 0) + 1
                        days_with_service.add(d)

    else:
        # no calendar.txt: use only calendar_dates.txt (exception_type=1)
        for sid, exmap in exceptions.items():
            for d, et in exmap.items():
                if et == 1:
                    service_days[sid] = service_days.get(sid, 0) + 1
                    days_with_service.add(d)

    service_active = {sid: (n > 0) for sid, n in service_days.items()}
    return service_days, service_active, days_with_service


def main():
    cartelle = scopri_cartelle_modo()
    print("modes found:", ", ".join(m for m, _ in cartelle))

    # GLOBAL accumulators (merged across all modes). The IDs are prefixed with the
    # mode to avoid collisions between different feeds.
    service_days = {}       # "mode::service_id" -> days
    service_active = {}     # "mode::service_id" -> bool
    trip_route = {}         # "mode::trip_id" -> "mode::route_id"
    trip_service = {}       # "mode::trip_id" -> "mode::service_id"
    trip_min = {}           # "mode::trip_id" -> sec
    trip_max = {}           # "mode::trip_id" -> sec
    all_active_dates = set()  # UNION of active dates of all modes

    for modo, base in cartelle:
        pref = "" if modo == "_flat" else f"{modo}::"

        # 1) mode calendar
        sd, sa, dates = build_service_calendar(base)
        for sid, n in sd.items():
            service_days[pref + sid] = n
        for sid, b in sa.items():
            service_active[pref + sid] = b
        all_active_dates |= dates

        # 2) mode trips.txt
        trips_path = os.path.join(base, "trips.txt")
        n_trips = 0
        if os.path.exists(trips_path):
            with open(trips_path, encoding="utf-8-sig") as f:
                for row in csv.DictReader(f):
                    tid = pref + row["trip_id"]
                    trip_route[tid] = pref + row.get("route_id", "")
                    trip_service[tid] = pref + row.get("service_id", "")
                    n_trips += 1

        # 3) mode stop_times.txt -> min(departure)/max(arrival) per trip
        st_path = os.path.join(base, "stop_times.txt")
        n_rows = 0
        if os.path.exists(st_path):
            with open(st_path, encoding="utf-8-sig") as f:
                for row in csv.DictReader(f):
                    tid = pref + row["trip_id"]
                    dep = hhmmss_to_sec(row.get("departure_time") or row.get("arrival_time"))
                    arr = hhmmss_to_sec(row.get("arrival_time") or row.get("departure_time"))
                    if dep is None and arr is None:
                        continue
                    lo = dep if dep is not None else arr
                    hi = arr if arr is not None else dep
                    if tid not in trip_min or lo < trip_min[tid]:
                        trip_min[tid] = lo
                    if tid not in trip_max or hi > trip_max[tid]:
                        trip_max[tid] = hi
                    n_rows += 1
        print(f"  [{modo}] trips={n_trips} stop_times_rows={n_rows} "
              f"active_dates={len(dates)}")

    calendar_presente = len(service_active) > 0
    days_count = len(all_active_dates)
    print(f"calendar (modes union): {len(service_active)} service_id, "
          f"days_count={days_count} (present={calendar_presente})")

    # 4a) SERIES 1: lines active per hour (aggregated over all days)
    active = [set() for _ in range(24)]
    # 4b) SERIES 2: total trips-per-hour summed over all real days
    trips_hour_sum = [0.0 for _ in range(24)]
    # 4c) SERIES 3: total TRIPS spread over all the hours traversed
    active_trips_hour_sum = [0.0 for _ in range(24)]

    for tid, lo in trip_min.items():
        hi = trip_max.get(tid, lo)
        route = trip_route.get(tid)
        sid = trip_service.get(tid)
        if route is None:
            continue
        if calendar_presente and not service_active.get(sid, False):
            continue

        # SERIES 1: the line is active in all the hours touched by the interval
        h_start = lo // 3600
        h_end = hi // 3600
        for h in range(h_start, h_end + 1):
            active[h % 24].add(route)

        # SERIES 2: the trip STARTS in the hour of its first departure; I count it
        # as many times as the days on which its service is active.
        peso = service_days.get(sid, 0) if calendar_presente else 1
        if peso > 0:
            trips_hour_sum[(lo // 3600) % 24] += peso
            for h in range(h_start, h_end + 1):
                active_trips_hour_sum[h % 24] += peso

    per_hour = [len(active[h]) for h in range(24)]
    total_lines = len(set(trip_route.values()))

    # daily average = sum of trip-days / number of days (modes union)
    denom = days_count if (calendar_presente and days_count > 0) else 1
    avg_trips_per_hour = [round(trips_hour_sum[h] / denom, 1) for h in range(24)]
    avg_active_trips_per_hour = [round(active_trips_hour_sum[h] / denom, 1) for h in range(24)]

    out_path = os.path.join(OUT, "lines_active_by_hour.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "per_hour": per_hour,
            "total_lines": total_lines,
            "avg_trips_per_hour": avg_trips_per_hour,
            "avg_active_trips_per_hour": avg_active_trips_per_hour,
            "days_count": days_count,
        }, f, indent=2)

    # textual control histograms
    vmax = max(per_hour) or 1
    print(f"\nTOTAL lines in the feed: {total_lines}")
    print(f"=== LINES ACTIVE PER HOUR (max {max(per_hour)}) ===")
    for h in range(24):
        bar = "#" * int(round(40 * per_hour[h] / vmax))
        print(f"  {h:02d}:00  {per_hour[h]:4d}  {bar}")

    amax = max(avg_trips_per_hour) or 1
    print(f"\n=== AVERAGE TRIPS PER HOUR (feed days: {days_count}) ===")
    for h in range(24):
        bar = "#" * int(round(40 * avg_trips_per_hour[h] / amax))
        print(f"  {h:02d}:00  {avg_trips_per_hour[h]:7.1f}  {bar}")

    a2max = max(avg_active_trips_per_hour) or 1
    print(f"\n=== AVERAGE VEHICLES IN CIRCULATION PER HOUR (feed days: {days_count}) ===")
    for h in range(24):
        bar = "#" * int(round(40 * avg_active_trips_per_hour[h] / a2max))
        print(f"  {h:02d}:00  {avg_active_trips_per_hour[h]:7.1f}  {bar}")

    print(f"\nOK -> {out_path}")


if __name__ == "__main__":
    main()
