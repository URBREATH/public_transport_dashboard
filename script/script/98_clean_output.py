# -*- coding: utf-8 -*-

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P

OUTPUT_DIR = P.OUTPUT_DIR
HEATMAP_DIR = os.path.join(OUTPUT_DIR, "heatmap")

HEATMAP_LOCAL_OUTPUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "col_heatmap_20260903", "output")

# --- Files in the ROOT of output/ to KEEP (deployed by 99_sync_assets) ---
KEEP_ROOT = {
    "city_bounds.json",
    "stop.geojson",
    "line.geojson",
    "pop_coverage_map.tif",
    "stop_info.json",
    "lines_active_by_hour.json",
    "analytics.json",
    "transit_desert.tif",               # Transit desert layer (GeoTIFF, step 10b)
    "transport_15min.geojson",          # optimized version step 14
    "heatmap_bus.tif",
    "heatmap_metro.tif",
    "heatmap_tram.tif",
    "heatmap_unione.tif",
    "heatmap_freq_soglie.json",
}

KEEP_HEATMAP = set()

# --- Folders in output/ to EMPTY completely (only intermediates between steps) ---
CLEAN_DIRS = {"processing"}


def _elenca_da_rimuovere():
    """Returns (files_to_remove, dirs_to_empty) without deleting anything."""
    file_rm = []
    dir_svuota = []
    if not os.path.isdir(OUTPUT_DIR):
        return file_rm, dir_svuota

    for name in sorted(os.listdir(OUTPUT_DIR)):
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isfile(path):
            if name not in KEEP_ROOT:
                file_rm.append(path)
        elif os.path.isdir(path):
            if name == "heatmap":
                for h in sorted(os.listdir(path)):
                    hp = os.path.join(path, h)
                    if os.path.isfile(hp) and h not in KEEP_HEATMAP:
                        file_rm.append(hp)
            elif name in CLEAN_DIRS:
                dir_svuota.append(path)
            # other unknown folders: leave them alone (caution)
    return file_rm, dir_svuota


def _size(path):
    try:
        return os.path.getsize(path)
    except Exception:
        return 0


def _fmt(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024:
            return f"{nbytes:.0f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.0f} TB"


def pulisci(apply=False, verbose=True):
    """Removes from output/ everything that is not in the whitelist.
    - apply=False -> DRY-RUN (does not delete, only lists).
    - apply=True  -> actually deletes.
    Returns the number of bytes freed (or freeable in dry-run).
    Callable both from CLI (main) and from import (e.g. 99_sync_assets.py).
    """
    file_rm, dir_svuota = _elenca_da_rimuovere()

    if verbose:
        print("=" * 70)
        print("  OUTPUT/ CLEANUP  (keeps only the files useful to the assets)")
        print("  MODE:", "APPLY (deletes)" if apply else "DRY-RUN (no deletion)")
        print("=" * 70)

    tot = 0
    if verbose:
        print(">> Files NOT in whitelist (would be removed):")
        if not file_rm:
            print("   (none)")
    for p in file_rm:
        s = _size(p)
        tot += s
        rel = os.path.relpath(p, OUTPUT_DIR)
        if verbose:
            print(f"   - {rel:45s} {_fmt(s)}")
        if apply:
            try:
                os.remove(p)
            except Exception as e:
                if verbose:
                    print(f"     [error] {e}")

    if verbose:
        print(">> Intermediate folders to empty:")
        if not dir_svuota:
            print("   (none)")
    for d in dir_svuota:
        rel = os.path.relpath(d, OUTPUT_DIR)
        cnt = 0
        for root, _dirs, files in os.walk(d):
            for f in files:
                fp = os.path.join(root, f)
                tot += _size(fp)
                cnt += 1
                if apply:
                    try:
                        os.remove(fp)
                    except Exception:
                        pass
        if verbose:
            print(f"   - {rel}/  ({cnt} files)")

    import shutil
    dir_da_rimuovere = [HEATMAP_DIR, os.path.join(OUTPUT_DIR, "processing"),
                        HEATMAP_LOCAL_OUTPUT]
    if verbose:
        print(">> Folders to REMOVE entirely (heatmap/ processing/ + local heatmap output):")
        stampata = False
        for d in dir_da_rimuovere:
            if os.path.isdir(d):
                print(f"   - {d}")
                stampata = True
        if not stampata:
            print("   (none)")
    if apply:
        for d in dir_da_rimuovere:
            if os.path.isdir(d):
                try:
                    shutil.rmtree(d)
                except Exception as e:
                    if verbose:
                        print(f"     [removal error] {d}: {e}")

    if verbose:
        print("-" * 70)
        print(f"  Space {'freed' if apply else 'freeable'}: {_fmt(tot)}")
        if not apply:
            print("  (run with --apply to actually delete)")
        print("  OK -> output/ cleaned." if apply else "  OK -> preview completed.")
        print("=" * 70)

    return tot


def main():
    apply = "--apply" in sys.argv
    pulisci(apply=apply, verbose=True)


if __name__ == "__main__":
    main()
