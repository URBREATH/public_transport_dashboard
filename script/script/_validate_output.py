# -*- coding: utf-8 -*-
"""
_validate_output.py - AUTOMATIC VALIDATOR of the full pipeline outputs.

Purpose: to ensure that, whatever GTFS data is put in data/, the pipeline
ALWAYS produces material USABLE by the dashboard. It is not enough that the
steps finish with returncode 0: a file may exist but be EMPTY/degenerate
(e.g. GeoJSON with 0 features, as happened with the old direct stop_id join).

This module checks, on the final files expected by the dashboard (same list
as 99_sync_assets.py), that each one:
  - exists;
  - is not empty (size > minimum threshold);
  - if GeoJSON: has >= 1 feature;
  - if JSON dict/list: is not {} or [] where content is expected;
  - if per-stop folder: contains at least 1 .json file.

Usage:
  - as a module:   from _validate_output import valida ; ok, problemi = valida()
  - from CLI:      python _validate_output.py    (exit 0 if all ok, 3 if there are
                   missing/empty CRITICAL outputs)

The checks are CITY-AGNOSTIC: no hardcoded count on Leuven/Madrid,
only "it exists and is not empty".
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P

OUTPUT_DIR = P.OUTPUT_DIR
HEATMAP_OUT = os.path.join(OUTPUT_DIR, "heatmap")

def _o(*p):
    return os.path.join(OUTPUT_DIR, *p)

def _h(*p):
    return os.path.join(HEATMAP_OUT, *p)

ATTESI = [
    # --- Main geographic layers (CRITICAL) ---
    (_o("stop.geojson"),                 "geojson",  "critico"),
    (_o("line.geojson"),                 "geojson",  "critico"),

    (_o("population_coverage.geojson"),  "geojson",  "opzionale"),

    (_o("transit_desert.tif"),           "tif",      "critico"),

    # --- City / view metadata (CRITICAL) ---
    (_o("city_bounds.json"),             "json",     "critico"),


    (_o("stop_info.json"),               "json",     "critico"),

    # --- Raster population (optional: if GHSL is missing the dashboard holds) ---
    (_o("pop_2025_layer.json"),          "json",     "opzionale"),
    (_o("pop_2025_layer.png"),           "png",      "opzionale"),
    (_o("population_2025.png"),          "png",      "opzionale"),

    # --- Frequency heatmap (optional: separate sub-pipeline) ---
    (_h("heatmap_freq_strade.geojson"),      "geojson", "opzionale"),
    (_h("heatmap_freq_raster.png"),          "png",     "opzionale"),
    (_h("heatmap_freq_raster_bounds.json"),  "json",    "opzionale"),
    (_h("heatmap_freq_celle.geojson"),       "geojson", "opzionale"),
    (_h("heatmap_freq_grid5m.geojson"),      "geojson", "opzionale"),
]

# transport_15min.geojson may be in output/ (optimized step 14) or in data/.
TRANSPORT_15MIN = ("transport_15min.geojson", "geojson", "critico")

MIN_BYTES = 8  # below this threshold the file is considered empty


def _conta_feature_geojson(path):
    """Returns the number of features of a GeoJSON, or -1 if unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            gj = json.load(f)
    except Exception:
        return -1
    if isinstance(gj, dict):
        feats = gj.get("features")
        if isinstance(feats, list):
            return len(feats)
        # it might be a single Feature
        if gj.get("type") == "Feature":
            return 1
    return -1


def _json_non_vuoto(path):
    """True if the JSON is a NON-empty dict/list (or a valid scalar)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except Exception:
        return False
    if isinstance(obj, (dict, list)):
        return len(obj) > 0
    return obj is not None


def _check_uno(path, tipo):
    """Returns (ok, detail) for a single expected output."""
    if tipo == "dir_json":
        if not os.path.isdir(path):
            return False, "missing folder"
        n = sum(1 for x in os.listdir(path) if x.endswith(".json"))
        if n == 0:
            return False, "folder without .json files"
        return True, f"{n} .json files"

    if not os.path.exists(path):
        return False, "missing file"
    size = os.path.getsize(path)
    if size < MIN_BYTES:
        return False, f"empty file ({size} B)"

    if tipo == "geojson":
        n = _conta_feature_geojson(path)
        if n < 0:
            return False, "unreadable/malformed geojson"
        if n == 0:
            return False, "geojson with 0 features"
        return True, f"{n} features"

    if tipo == "json":
        if not _json_non_vuoto(path):
            return False, "empty/malformed json"
        return True, f"{size} B"

    if tipo == "png":
        # a valid PNG starts with the \x89PNG signature
        try:
            with open(path, "rb") as f:
                head = f.read(8)
            if head[:4] != b"\x89PNG":
                return False, "png with invalid signature"
        except Exception:
            return False, "unreadable png"
        return True, f"{size} B"

    return True, f"{size} B"


def valida(verbose=True):
    """
    Runs all the checks. Returns (tutto_ok, problemi) where:
      - tutto_ok: True if there are NO missing/empty CRITICAL outputs;
      - problemi: list of dict {path, tipo, criticita, dettaglio}.
    Missing optional outputs generate only warnings (they do not cause failure).
    """
    voci = list(ATTESI)

    # transport_15min: accepts output/ or data/
    p_out = os.path.join(OUTPUT_DIR, TRANSPORT_15MIN[0])
    p_data = P.data(TRANSPORT_15MIN[0])
    t15_path = p_out if os.path.exists(p_out) else p_data
    voci.append((t15_path, TRANSPORT_15MIN[1], TRANSPORT_15MIN[2]))

    problemi = []
    ok_count = 0
    if verbose:
        print("=" * 70)
        print("  DASHBOARD OUTPUT VALIDATION")
        print("=" * 70)

    for path, tipo, crit in voci:
        ok, dettaglio = _check_uno(path, tipo)
        nome = os.path.relpath(path, OUTPUT_DIR)
        if ok:
            ok_count += 1
            if verbose:
                print(f"  [OK]        {nome:45s} {dettaglio}")
        else:
            problemi.append({"path": path, "tipo": tipo,
                             "criticita": crit, "dettaglio": dettaglio})
            tag = "CRITICAL" if crit == "critico" else "warning"
            if verbose:
                print(f"  [{tag:7s}]  {nome:45s} {dettaglio}")

    critici = [p for p in problemi if p["criticita"] == "critico"]
    tutto_ok = len(critici) == 0

    if verbose:
        print("-" * 70)
        print(f"  OK: {ok_count}/{len(voci)}  |  critical problems: {len(critici)}  |  "
              f"warnings: {len(problemi) - len(critici)}")
        if tutto_ok:
            print("  RESULT: OUTPUT USABLE BY THE DASHBOARD.")
        else:
            print("  RESULT: OUTPUT NOT USABLE - CRITICAL files missing/empty:")
            for p in critici:
                print(f"     - {os.path.relpath(p['path'], OUTPUT_DIR)}: {p['dettaglio']}")
        print("=" * 70)

    return tutto_ok, problemi


if __name__ == "__main__":
    ok, _ = valida(verbose=True)
    sys.exit(0 if ok else 3)
