# -*- coding: utf-8 -*-
"""
_pipe.py - Shared helper of the FULL Leuven 15-min PIPELINE.

Centralizes the common paths (data/, output/, output/processing/) and provides
utilities for the PROGRESS BARS and the "processed X out of Y" messages.

Folder structure (relative to this file):
    pipe_completa/
    ├── data/                 <- input (QGIS gpkg, boundary geojson, GTFS raw data)
    │   └── dati_grezzi/
    ├── output/               <- ONLY final files for the Angular assets
    │   └── processing/       <- intermediate files between one step and the next
    └── script/               <- this file + scripts 01..08 + script_heatmap_freq/

Each pipeline script imports this module with (robust pattern,
runnable both standalone and from the orchestrator):
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _pipe as P
    data, out, proc, progress = P.data, P.out, P.proc, P.progress
"""
import os
import sys

# --- Roots (computed relative to this file: script/_pipe.py) -------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))          # .../pipe_completa/script
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)                         # .../pipe_completa
DATA_DIR   = os.path.join(ROOT_DIR, "data")                     # shared inputs
RAW_DIR    = os.path.join(ROOT_DIR, "data", "raw_data")  # shared raw GTFS (PATCH-LUCA: consolidated in data/raw_data, so data_separati/ can be deleted)
OUTPUT_DIR = os.path.join(ROOT_DIR, "output")                  # ONLY final dashboard files
PROCESSING_DIR = os.path.join(OUTPUT_DIR, "processing")        # intermediate between steps

# Create the output folders if they don't exist (input data is NOT created)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PROCESSING_DIR, exist_ok=True)

# stdout in UTF-8 (avoids crashes on Windows with accented characters/emoji)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# --- Path helpers --------------------------------------------------------
def data(*parts):
    """Path inside data/ (input)."""
    return os.path.join(DATA_DIR, *parts)


def raw(*parts):
    """Path inside data/raw_data/ (raw GTFS)."""
    return os.path.join(RAW_DIR, *parts)


def data_any(*names):
    """
    CITY-AGNOSTIC: given a list of ALTERNATIVE NAMES (aliases) of the same
    input file in data/, returns the path of the FIRST that actually exists.

    Needed because the same layer may come from QGIS with slightly different
    names depending on the city/export (e.g. 'transit_desert.gpkg' in the
    singular vs 'transit_deserts.gpkg' in the plural). Instead of hardcoding a
    fixed name, the steps pass all plausible aliases and the pipeline uses the
    one present, whatever the city.

    If NO alias exists, it returns the path of the FIRST name (so the
    subsequent read_file() will fail with a clear error on that expected path).
    """
    for n in names:
        p = os.path.join(DATA_DIR, n)
        if os.path.exists(p):
            return p
    return os.path.join(DATA_DIR, names[0]) if names else DATA_DIR


def out(*parts):
    """Path inside output/ (final files for the assets)."""
    return os.path.join(OUTPUT_DIR, *parts)


def proc(*parts):
    """Path inside output/processing/ (intermediate files)."""
    return os.path.join(PROCESSING_DIR, *parts)


# --- Progress bar (tqdm if available, simple fallback) ----------
try:
    from tqdm import tqdm  # live bar with "processed X/Y" and speed
    HAS_TQDM = True
except Exception:
    HAS_TQDM = False


def progress(iterable=None, total=None, desc="", unit="it"):
    """
    Returns an iterable with a progress bar.
    Typical use on chunked reading of a huge CSV:

        for chunk in progress(pd.read_csv(path, chunksize=CH), desc="stop_times"):
            ...

    If tqdm is not installed, it degrades to a simple textual counter.
    """
    if HAS_TQDM:
        return tqdm(iterable, total=total, desc=desc, unit=unit,
                    ncols=90, dynamic_ncols=True, leave=True)

    # Minimal fallback without dependencies
    def _gen():
        n = 0
        for item in (iterable or []):
            n += 1
            if n % 5 == 0 or (total and n == total):
                if total:
                    print(f"   [{desc}] {n}/{total}", flush=True)
                else:
                    print(f"   [{desc}] blocks processed: {n}", flush=True)
            yield item
    return _gen()


def banner(step_idx, step_tot, titolo):
    """Prints a clear header for the transition from one step to the next."""
    barra = "=" * 70
    print("\n" + barra, flush=True)
    print(f"  STEP {step_idx}/{step_tot}  ·  {titolo}", flush=True)
    print(barra, flush=True)


def riepilogo(**kv):
    """Prints a summary line of processed data, e.g.: riepilogo(rows=123, features=45)."""
    parts = [f"{k}={v}" for k, v in kv.items()]
    print("   -> " + " | ".join(parts), flush=True)


# --- Join stops <-> GTFS stop_id (CITY-AGNOSTIC) -------------------------
def build_stop_id_map(local_stop_ids, raw_dir):
    """
    Builds a map  GTFS_stop_id -> local_stop_id  that is robust and valid for
    ANY dataset/city, without hardcoded prefixes.

    Problem solved: in some feeds (e.g. De Lijn / Leuven) the GTFS uses stop_id
    of the form '<feedid>-<code>' (e.g. '1014-303457'), while the stops geojson
    exposes the "bare" stop_id (e.g. '303457'). In other feeds (e.g. Madrid)
    the geojson stop_id already matches 1:1 the GTFS one. A direct-only match
    works for Madrid but zeroes out Leuven (0 matches -> empty outputs); a fixed
    prefix '1014-' would do the opposite.

    Cascading strategy (for each local stop the first that matches is chosen):
      1) DIRECT match         local_id == gtfs_stop_id
      2) match via STOP_CODE  local_id == stops.txt.stop_code
      3) match via SUFFIX     local_id == part after the last separator
                               ('-' or ':') of the gtfs_stop_id

    Returns:
      gtfs_to_local : dict {gtfs_stop_id -> local_stop_id}  (to translate the
                      stop_times.txt rows to the local id)
      gtfs_ids      : set of GTFS stop_ids to search in stop_times.txt
      stats         : dict with diagnostic counts (direct/code/suffix/unmatched)
    """
    import os as _os
    import csv as _csv

    local_set = set(str(s) for s in local_stop_ids)

    # Indexes from the GTFS stops.txt
    all_gtfs_ids = set()
    code_to_gid = {}       # stop_code -> gtfs_stop_id
    suffix_to_gid = {}     # suffix(after '-'/':') -> gtfs_stop_id
    stops_path = _os.path.join(raw_dir, "stops.txt")
    with open(stops_path, encoding="utf-8-sig") as f:
        for r in _csv.DictReader(f):
            gid = r.get("stop_id", "")
            if not gid:
                continue
            all_gtfs_ids.add(gid)
            code = (r.get("stop_code", "") or "").strip()
            if code and code not in code_to_gid:
                code_to_gid[code] = gid
            suf = gid
            for sep in ("-", ":"):
                if sep in suf:
                    suf = suf.split(sep)[-1]
            if suf and suf not in suffix_to_gid:
                suffix_to_gid[suf] = gid

    gtfs_to_local = {}
    n_direct = n_code = n_suffix = n_unmatched = 0
    for lid in local_set:
        if lid in all_gtfs_ids:                    # 1) direct
            gtfs_to_local[lid] = lid
            n_direct += 1
        elif lid in code_to_gid:                   # 2) via stop_code
            gtfs_to_local[code_to_gid[lid]] = lid
            n_code += 1
        elif lid in suffix_to_gid:                 # 3) via suffix
            gtfs_to_local[suffix_to_gid[lid]] = lid
            n_suffix += 1
        else:
            n_unmatched += 1

    stats = {
        "local_stops": len(local_set),
        "match_direct": n_direct,
        "match_code": n_code,
        "match_suffix": n_suffix,
        "unmatched": n_unmatched,
        "gtfs_ids_to_scan": len(gtfs_to_local),
    }
    print("[stop_id map] local=%d | direct=%d | via_code=%d | via_suffix=%d | unmatched=%d"
          % (stats["local_stops"], n_direct, n_code, n_suffix, n_unmatched), flush=True)
    return gtfs_to_local, set(gtfs_to_local.keys()), stats
