# -*- coding: utf-8 -*-
"""
99_sync_assets.py - DEPLOY STEP: syncs the pipeline outputs into the assets
folder of the Angular dashboard (frontend/src/assets).

Copies ONLY the files/folders actually expected by the dashboard, with the
correct names. In particular:
  - the .geojson / .json / .tif produced by steps 00..16 (from output/)
  - transport_15min.geojson (INPUT in data/, but it is also an asset)
  - the per-mode heatmap outputs (from col_heatmap_20260903, deployed by
    its step 6)
It does NOT copy legacy outputs not used by the assets.

Finds the assets folder by walking up the tree, so it works at any depth.
"""
import os
import sys
import shutil
import importlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P

_clean = importlib.import_module("98_clean_output")

DATA_DIR = P.DATA_DIR
OUTPUT_DIR = P.OUTPUT_DIR


ASSET_ATTESI = {
    # Final files from output/
    "city_bounds.json",
    "stop.geojson",
    "line.geojson",
    "pop_coverage_map.tif",
    "stop_info.json",
    "lines_active_by_hour.json",
    "analytics.json",
    "transit_desert.tif",
    "transport_15min.geojson",
    "pop_legend.png",
    "heatmap_bus.tif",
    "heatmap_metro.tif",
    "heatmap_tram.tif",
    "heatmap_unione.tif",
    "heatmap_freq_soglie.json",
}


def _pulisci_assets(assets_dir, verbose=True):
    """Removes from the assets all FILES not present in ASSET_ATTESI.
    Subfolders are NOT touched (caution). Returns the list of removed ones."""
    rimossi = []
    if not os.path.isdir(assets_dir):
        return rimossi
    for name in sorted(os.listdir(assets_dir)):
        path = os.path.join(assets_dir, name)
        if os.path.isfile(path) and name not in ASSET_ATTESI:
            try:
                os.remove(path)
                rimossi.append(name)
                if verbose:
                    print(f"  [removed] {name}")
            except Exception as e:
                if verbose:
                    print(f"  [removal error] {name}: {e}")
    if verbose and not rimossi:
        print("  (no extraneous file)")
    return rimossi


def _trova_assets(start, max_risalite=8):
    cur = start
    for _ in range(max_risalite):
        cand = os.path.join(cur, "frontend", "src", "assets")
        if os.path.isdir(cand):
            return os.path.abspath(cand)
        nuovo = os.path.dirname(cur)
        if nuovo == cur:
            break
        cur = nuovo
    return None


ASSETS = _trova_assets(os.path.dirname(os.path.abspath(__file__)))


FILE_DA_OUTPUT = [
    ("city_bounds.json", "city_bounds.json"),
    ("stop.geojson", "stop.geojson"),
    ("line.geojson", "line.geojson"),
    ("pop_coverage_map.tif", "pop_coverage_map.tif"),
    ("transit_desert.tif", "transit_desert.tif"),
    ("stop_info.json", "stop_info.json"),
    ("lines_active_by_hour.json", "lines_active_by_hour.json"),
    ("analytics.json", "analytics.json"),
]

CARTELLE_DA_OUTPUT = []

# Files that are INPUT (in data/) but also assets for the dashboard.
FILE_DA_DATA = ["transport_15min.geojson"]

FILE_DA_DATA_STATICI = [
    ("pop_legend.png", "pop_legend.png"),
]

FILE_HEATMAP = []


def _copia_file(src, nome):
    if not os.path.exists(src):
        print(f"  [MISSING] {nome}  (expected: {src})")
        return False
    shutil.copy2(src, os.path.join(ASSETS, nome))
    print(f"  [ok]   {nome}")
    return True


def _copia_cartella(nome):
    src = os.path.join(OUTPUT_DIR, nome)
    if not os.path.isdir(src):
        print(f"  [MISSING] {nome}/  (expected: {src})")
        return False
    dst = os.path.join(ASSETS, nome)
    os.makedirs(dst, exist_ok=True)
    # cleanup of old files (.json AND .geojson): when changing city the tiles/board
    # of the previous city must NOT remain (e.g. transport_tiles/*.geojson).
    for old in os.listdir(dst):
        if old.endswith(".json") or old.endswith(".geojson"):
            try:
                os.remove(os.path.join(dst, old))
            except Exception:
                pass
    n = 0
    for name in os.listdir(src):
        sp = os.path.join(src, name)
        if os.path.isfile(sp):
            shutil.copy2(sp, os.path.join(dst, name))
            n += 1
    print(f"  [ok]   {nome}/  ({n} files)")
    return True


def _copia_cartella_da(src, nome):
    """Like _copia_cartella but with an EXPLICIT source path (not necessarily in
    OUTPUT_DIR). Used for nested folders like output/heatmap/freq_cells_tiles/."""
    if not os.path.isdir(src):
        print(f"  [MISSING] {nome}/  (expected: {src})")
        return False
    dst = os.path.join(ASSETS, nome)
    os.makedirs(dst, exist_ok=True)
    for old in os.listdir(dst):
        if old.endswith(".json") or old.endswith(".geojson"):
            try:
                os.remove(os.path.join(dst, old))
            except Exception:
                pass
    n = 0
    for name in os.listdir(src):
        sp = os.path.join(src, name)
        if os.path.isfile(sp):
            shutil.copy2(sp, os.path.join(dst, name))
            n += 1
    print(f"  [ok]   {nome}/  ({n} files)")
    return True


def _copia_transit_desert():
    return True


def main():
    if ASSETS is None:
        print("ERROR: frontend/src/assets folder not found while walking up the tree.")
        sys.exit(1)
    os.makedirs(ASSETS, exist_ok=True)
    print("STEP 99 - Sync dashboard assets ->", ASSETS)

    print(">> Files from output/:")
    for nome_src, nome_dst in FILE_DA_OUTPUT:
        _copia_file(os.path.join(OUTPUT_DIR, nome_src), nome_dst)

    print(">> Transit desert (GeoTIFF transit_desert.tif deployed above by FILE_DA_OUTPUT)")

    print(">> Files from data/ (inputs that are also assets):")
    for nome in FILE_DA_DATA:

        src_opt = os.path.join(OUTPUT_DIR, nome)
        if os.path.exists(src_opt):
            _copia_file(src_opt, nome)
        else:
            _copia_file(os.path.join(DATA_DIR, nome), nome)

    print(">> Static files from data/ (only data/, no output/):")
    for nome_src, nome_dst in FILE_DA_DATA_STATICI:
        _copia_file(os.path.join(DATA_DIR, nome_src), nome_dst)

    print(">> Per-stop folders:")
    for nome in CARTELLE_DA_OUTPUT:
        _copia_cartella(nome)

    print(">> Output heatmap (output/heatmap/):")
    heat = os.path.join(OUTPUT_DIR, "heatmap")
    for nome in FILE_HEATMAP:
        _copia_file(os.path.join(heat, nome), nome)

    print("OK -> assets synced.")

    print(">> Assets cleanup (removal of extraneous files):")
    _pulisci_assets(ASSETS, verbose=True)

    print(">> output/ cleanup (removal of non-asset files):")
    _clean.pulisci(apply=True, verbose=True)


if __name__ == "__main__":
    main()
