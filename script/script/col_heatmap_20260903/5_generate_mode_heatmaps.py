# -*- coding: utf-8 -*-
"""
=============================================================================
GENERATE FREQUENCY HEATMAP PER MODALITY (bus / metro / tram) + UNION
=============================================================================


INPUT
-----
Reads the separated GTFS from:
    data_separati/raw_data/<modalita>/    (bus, metro, tram)
AUTOMATICALLY detects which folders exist:
  - if there is only 'bus'      -> generates only bus
  - if all three are present     -> generates bus, metro, tram (+ union)

WHAT IT DOES (for each modality present)
----------------------------------------
1. Builds the shapes (LineString) from shapes.txt          (like STEP 2).
2. Computes the daily frequency per shape                  (like STEP 3,
   automatic method frequencies.txt / trips).
3. Joins shape + frequency -> GeoDataFrame with a 'freq' field.
4. Rasterizes SIMULATING QGIS's gdal_rasterize:
       - raster CRS:            EPSG:3857 (WGS 84 / Pseudo-Mercator)
       - burn field:            freq (freq_giornaliera per shape)
       - resolution:            40 m x 40 m (georeferenced units)
       - output data type:      UInt16
       - -add parameter:        the contributions of overlapping shapes are
                                SUMMED into the same cell (accumulation).
   -> heatmap_<modalita>.tif  (raw raster, values = sum of freq)
5. Themes the raster into a "single-band false color" with the 'Reds' palette
   -> heatmap_<modalita>_reds.tif (RGBA) + heatmap_<modalita>_reds.png (preview)

UNION (4th heatmap)
-------------------
Concatenates the shape+freq of ALL the modalities present and redoes steps 4-5:
   -> heatmap_unione.tif + heatmap_unione_reds.tif/.png

OUTPUT
------
Everything in:  col_heatmap_20260903/output/

TECHNICAL NOTES
---------------
- gdal_rasterize is not available as a CLI in this environment: I use rasterio
  (which underneath uses GDAL) with rasterize(merge_alg=ADD) to replicate EXACTLY
  the behavior of -add. Grid aligned to multiples of 40 m.
- The burned "freq" is the freq_giornaliera (sum of period passages / period
  days) computed by the automatic method already present in STEP 3.
=============================================================================
"""

import os
import sys
import math
import json
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString

import rasterio
from rasterio.transform import from_origin
from rasterio.features import rasterize
from rasterio.enums import MergeAlg, Resampling
from rasterio.warp import calculate_default_transform, reproject

import matplotlib
matplotlib.use("Agg")
import matplotlib.cm as cm
import matplotlib.colors as mcolors

# -------------------------------------------------------------------------
# Base paths (independent of the position thanks to walking up the tree)
# -------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)


def _trova_su(nome_relativo, start=BASE_DIR, max_risalite=8):
    cur = start
    for _ in range(max_risalite):
        cand = os.path.join(cur, nome_relativo)
        if os.path.exists(cand):
            return os.path.abspath(cand)
        nuovo = os.path.dirname(cur)
        if nuovo == cur:
            break
        cur = nuovo
    return None

RAW_DATA = (
    _trova_su(os.path.join("data", "raw_data"))
    or _trova_su(os.path.join("data_separati", "raw_data"))
)

# Required parameters (QGIS gdal_rasterize)
CRS_RASTER = "EPSG:3857"       # WGS 84 / Pseudo-Mercator (40m metric grid for the rasterization)
CRS_OUTPUT = "EPSG:4326"       # CRS of the OUTPUT .tif: the dashboard (GeoRasterLayer + click) assumes lat/lon
RES_METRI = 40.0               # cell width/height in georeferenced units (m)
DTYPE_OUT = "uint16"           # output data type
MERGE = MergeAlg.add           # -add parameter (sums the overlapping contributions)
PALETTE = "Reds"               # single-band false color -> Reds

MODALITA = ["bus", "metro", "tram"]


def log(msg):
    print(f"[gen_heatmap] {msg}", flush=True)


# =========================================================================
# STEP 2 (adapted) - Shapes (LineString) from a modality's shapes.txt
# =========================================================================
def costruisci_shape(cartella_mod):
    f_shapes = os.path.join(cartella_mod, "shapes.txt")
    if not os.path.isfile(f_shapes):
        log(f"  [warn] shapes.txt missing in {cartella_mod}")
        return gpd.GeoDataFrame(columns=["shape_id", "geometry"], crs="EPSG:4326")

    df = pd.read_csv(
        f_shapes,
        dtype={"shape_id": str},
        usecols=["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
    )
    df["shape_pt_lat"] = pd.to_numeric(df["shape_pt_lat"], errors="coerce")
    df["shape_pt_lon"] = pd.to_numeric(df["shape_pt_lon"], errors="coerce")
    df["shape_pt_sequence"] = pd.to_numeric(df["shape_pt_sequence"], errors="coerce")
    df = df.dropna(subset=["shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])
    df = df.sort_values(["shape_id", "shape_pt_sequence"])

    records = []
    for shape_id, g in df.groupby("shape_id", sort=False):
        coords = list(zip(g["shape_pt_lon"], g["shape_pt_lat"]))
        if len(coords) < 2:
            continue
        records.append({"shape_id": shape_id, "geometry": LineString(coords)})

    gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")
    log(f"  shapes geometrized: {len(gdf)}")
    return gdf


# =========================================================================
# STEP 3 (adapted from the NEW method) - daily frequency per shape
#   Automatically recognizes frequencies.txt vs trips.
# =========================================================================
def _parse_data_gtfs(v):
    return datetime.strptime(str(v).strip(), "%Y%m%d").date()


def _tempo_in_secondi(v):
    try:
        h, m, s = map(int, str(v).strip().split(":"))
        return h * 3600 + m * 60 + s
    except (ValueError, TypeError, AttributeError):
        return None


def _intervallo_date(d0, d1):
    d = d0
    while d <= d1:
        yield d
        d += timedelta(days=1)


def calcola_date_attive(cartella_mod):
    """Active dates per service_id + overall period (days)."""
    f_cal = os.path.join(cartella_mod, "calendar.txt")
    f_cd = os.path.join(cartella_mod, "calendar_dates.txt")

    date_attive = {}
    date_estremi = []

    weekday_cols = ["monday", "tuesday", "wednesday", "thursday",
                    "friday", "saturday", "sunday"]

    if os.path.isfile(f_cal) and os.path.getsize(f_cal) > 0:
        cal = pd.read_csv(f_cal, dtype=str)
        for c in weekday_cols:
            if c in cal.columns:
                cal[c] = pd.to_numeric(cal[c], errors="coerce").fillna(0).astype(int)
            else:
                cal[c] = 0
        cal["service_id"] = cal["service_id"].fillna("").str.strip()
        cal["data_inizio"] = cal["start_date"].apply(_parse_data_gtfs)
        cal["data_fine"] = cal["end_date"].apply(_parse_data_gtfs)

        for _, r in cal.iterrows():
            sid = r["service_id"]
            if not sid:
                continue
            wk = [r[c] for c in weekday_cols]
            s = date_attive.setdefault(sid, set())
            for d in _intervallo_date(r["data_inizio"], r["data_fine"]):
                if wk[d.weekday()] == 1:
                    s.add(d)
        date_estremi += cal["data_inizio"].tolist() + cal["data_fine"].tolist()

    # exceptions
    if os.path.isfile(f_cd) and os.path.getsize(f_cd) > 0:
        try:
            cd = pd.read_csv(f_cd, dtype=str)
        except Exception:
            cd = pd.DataFrame()
        if not cd.empty and {"service_id", "date", "exception_type"}.issubset(cd.columns):
            cd["service_id"] = cd["service_id"].fillna("").str.strip()
            cd["data_ecc"] = cd["date"].apply(_parse_data_gtfs)
            for _, r in cd.iterrows():
                sid = r["service_id"]
                if not sid:
                    continue
                d = r["data_ecc"]
                et = str(r["exception_type"]).strip()
                s = date_attive.setdefault(sid, set())
                if et == "1":
                    s.add(d)
                elif et == "2":
                    s.discard(d)
            date_estremi += cd["data_ecc"].tolist()

    if not date_estremi:
        raise ValueError(f"Unable to determine the GTFS period in {cartella_mod}")

    inizio = min(date_estremi)
    fine = max(date_estremi)
    giorni_periodo = (fine - inizio).days + 1
    n_date = {sid: len(dates) for sid, dates in date_attive.items()}
    return n_date, giorni_periodo, inizio, fine


def leggi_trips(cartella_mod):
    f_trips = os.path.join(cartella_mod, "trips.txt")
    header = pd.read_csv(f_trips, nrows=0).columns.tolist()
    cols = [c for c in ["route_id", "service_id", "trip_id", "shape_id"] if c in header]
    if "direction_id" in header:
        cols.append("direction_id")
    trips = pd.read_csv(f_trips, dtype=str, usecols=cols)
    for c in cols:
        trips[c] = trips[c].fillna("").str.strip()
    trips = trips[(trips["service_id"] != "") &
                  (trips["trip_id"] != "") &
                  (trips["shape_id"] != "")].copy()
    key = [c for c in ["service_id", "trip_id", "shape_id", "direction_id"] if c in trips.columns]
    trips = trips.drop_duplicates(subset=key, keep="first").copy()
    return trips


def leggi_frequencies(cartella_mod):
    """Returns a DataFrame of valid time bands with n_corse, or None if not usable."""
    f_freq = os.path.join(cartella_mod, "frequencies.txt")
    if not os.path.isfile(f_freq) or os.path.getsize(f_freq) == 0:
        return None
    try:
        freq = pd.read_csv(f_freq, dtype=str)
    except Exception:
        return None
    need = ["trip_id", "start_time", "end_time", "headway_secs"]
    if freq.empty or not set(need).issubset(freq.columns):
        return None
    freq = freq[need].copy()
    freq["trip_id"] = freq["trip_id"].fillna("").str.strip()
    freq["start_sec"] = freq["start_time"].apply(_tempo_in_secondi)
    freq["end_sec"] = freq["end_time"].apply(_tempo_in_secondi)
    freq["headway_secs"] = pd.to_numeric(freq["headway_secs"], errors="coerce")
    freq = freq.dropna(subset=["start_sec", "end_sec", "headway_secs"])
    freq = freq[(freq["trip_id"] != "") &
                (freq["headway_secs"] > 0) &
                (freq["end_sec"] > freq["start_sec"])].copy()
    if freq.empty:
        return None
    freq["n_corse"] = ((freq["end_sec"] - freq["start_sec"]) /
                       freq["headway_secs"]).apply(math.ceil).astype(int)
    return freq


def frequenza_per_shape(cartella_mod):
    """Logical CSV: DataFrame [shape_id, passaggi_totali, freq_giornaliera]."""
    n_date, giorni_periodo, ini, fin = calcola_date_attive(cartella_mod)
    trips = leggi_trips(cartella_mod)
    freq = leggi_frequencies(cartella_mod)

    if freq is not None and not freq.empty:
        metodo = "FREQUENCIES"
        tf = trips.merge(freq, on="trip_id", how="inner")
        pattern = [c for c in ["route_id", "shape_id", "service_id",
                               "start_time", "end_time", "headway_secs",
                               "direction_id"] if c in tf.columns]
        tf = tf.drop_duplicates(subset=pattern, keep="first").copy()
        tf["corse_giornaliere"] = tf["n_corse"].astype(int)
        tf["giorni_attivi"] = tf["service_id"].map(n_date).fillna(0).astype(int)
        tf["passaggi_periodo"] = tf["corse_giornaliere"] * tf["giorni_attivi"]
        dati = tf
    else:
        metodo = "TRIPS"
        ts = trips.copy()
        ts["giorni_attivi"] = ts["service_id"].map(n_date).fillna(0).astype(int)
        ts["corse_giornaliere"] = 1
        ts["passaggi_periodo"] = ts["corse_giornaliere"] * ts["giorni_attivi"]
        dati = ts

    agg = (dati.groupby("shape_id", as_index=False)["passaggi_periodo"]
           .sum().rename(columns={"passaggi_periodo": "passaggi_totali"}))
    agg["freq_giornaliera"] = agg["passaggi_totali"] / giorni_periodo
    log(f"  freq method: {metodo} | period {ini}->{fin} ({giorni_periodo} days) | "
        f"shapes with freq: {len(agg)} | mean freq {agg.freq_giornaliera.mean():.2f}")
    return agg


# =========================================================================
# Building the shape + freq GeoDataFrame (in EPSG:3857) for a modality
# =========================================================================
def shape_con_frequenza(cartella_mod):
    gdf = costruisci_shape(cartella_mod)
    if gdf.empty:
        return gdf
    freq = frequenza_per_shape(cartella_mod)
    gdf = gdf.merge(freq[["shape_id", "freq_giornaliera"]], on="shape_id", how="left")
    gdf["freq"] = gdf["freq_giornaliera"].fillna(0.0)
    gdf = gdf[gdf["freq"] > 0].copy()               # only shapes with passages
    gdf = gdf.to_crs(CRS_RASTER)                     # -> EPSG:3857
    log(f"  shapes with freq>0 (in {CRS_RASTER}): {len(gdf)}")
    return gdf[["shape_id", "freq", "geometry"]]


# =========================================================================
# RASTERIZATION gdal_rasterize-style: -a freq -tr 40 40 -ot UInt16 -add
# =========================================================================
def rasterizza_add(gdf, nome, bounds_globali=None):
    """
    Burns the 'freq' field onto a 40x40 m grid in EPSG:3857, summing the
    contributions of the overlapping geometries (MergeAlg.add = -add parameter).
    Returns (array_uint16, transform, bounds_used).
    """
    if bounds_globali is not None:
        minx, miny, maxx, maxy = bounds_globali
    else:
        minx, miny, maxx, maxy = gdf.total_bounds

    # Align the extent to multiples of RES_METRI (as gdal_rasterize does)
    minx = math.floor(minx / RES_METRI) * RES_METRI
    miny = math.floor(miny / RES_METRI) * RES_METRI
    maxx = math.ceil(maxx / RES_METRI) * RES_METRI
    maxy = math.ceil(maxy / RES_METRI) * RES_METRI

    width = int(round((maxx - minx) / RES_METRI))
    height = int(round((maxy - miny) / RES_METRI))
    transform = from_origin(minx, maxy, RES_METRI, RES_METRI)

    # --- RASTER: SUM of the freq of the shapes crossing the cell ---
    # merge_alg=ADD -> equivalent of -add: the cells SUM the contributions.
    # The final cell value is the SUM of the frequencies of all the
    # shapes crossing it. It is exactly the value read
    # by clicking the cell in QGIS (Identify) and on which the theming is based.
    shapes_somma = ((geom, float(val)) for geom, val in zip(gdf.geometry, gdf["freq"]))
    somma = rasterize(
        shapes=shapes_somma,
        out_shape=(height, width),
        transform=transform,
        fill=0.0,
        merge_alg=MERGE,
        dtype="float64",
        all_touched=True,       # like QGIS with thin lines: touches all crossed cells
    )

    # Round and convert to UInt16 (0..65535), as required on output
    arr_round = np.rint(somma)
    np.clip(arr_round, 0, 65535, out=arr_round)
    arr_u16 = arr_round.astype(np.uint16)

    out_tif = os.path.join(OUTPUT_DIR, f"heatmap_{nome}.tif")

    # --- REPROJECTION to EPSG:4326 before writing the raw .tif ---
    # The dashboard (GeoRasterLayer + the lat/lng->col/row click) assumes the
    # GeoTIFF is in geographic coordinates (lat/lon). If we left it in
    # EPSG:3857 (meters) the click would always fall outside the bounds (lng in degrees vs
    # xmin/xmax in meters) and would NOT show the value. NEAREST warp to
    # preserve the integer frequency values.
    dst_transform, dst_width, dst_height = calculate_default_transform(
        CRS_RASTER, CRS_OUTPUT, width, height, minx, miny, maxx, maxy
    )
    arr_4326 = np.zeros((dst_height, dst_width), dtype=DTYPE_OUT)
    reproject(
        source=arr_u16,
        destination=arr_4326,
        src_transform=transform,
        src_crs=CRS_RASTER,
        dst_transform=dst_transform,
        dst_crs=CRS_OUTPUT,
        resampling=Resampling.nearest,
        src_nodata=0,
        dst_nodata=0,
    )

    with rasterio.open(
        out_tif, "w",
        driver="GTiff",
        height=dst_height, width=dst_width,
        count=1, dtype=DTYPE_OUT,
        crs=CRS_OUTPUT, transform=dst_transform,
        nodata=0, compress="deflate",
    ) as dst:
        dst.write(arr_4326, 1)

    vmax = int(arr_u16.max())
    log(f"  raster {nome}: {width}x{height} px @ {RES_METRI:.0f}m {DTYPE_OUT} "
        f"UInt16 -add (SUM freq) | max sum freq/cell = {vmax} "
        f"-> reprojected {CRS_OUTPUT} ({dst_width}x{dst_height}) -> {os.path.basename(out_tif)}")
    return arr_u16, transform, (minx, miny, maxx, maxy)


# =========================================================================
# THEMING: single-band false color, Reds palette
# =========================================================================
def tematizza_reds(arr_u16, transform, nome):
    """
    Applies the 'Reds' palette (single-band false color) on values > 0,
    transparent where freq = 0. Saves an RGBA GeoTIFF + PNG preview.
    """
    vmax = int(arr_u16.max())
    if vmax <= 0:
        log(f"  [warn] {nome}: empty raster, skipping theming")
        return

    # Linear normalization 1..vmax (0 = transparent/nodata)
    norm = mcolors.Normalize(vmin=1, vmax=vmax)
    try:
        cmap = matplotlib.colormaps[PALETTE]          # matplotlib >= 3.9
    except Exception:
        cmap = cm.get_cmap(PALETTE)                   # fallback for old versions
    rgba = cmap(norm(arr_u16.astype(float)))          # HxWx4 in 0..1
    rgba = (rgba * 255).astype(np.uint8)

    # alpha 0 where freq == 0
    alpha = np.where(arr_u16 > 0, 255, 0).astype(np.uint8)
    rgba[:, :, 3] = alpha

    height, width = arr_u16.shape

    # RGBA GeoTIFF (4 bands) georeferenced in EPSG:3857
    out_tif = os.path.join(OUTPUT_DIR, f"heatmap_{nome}_reds.tif")
    with rasterio.open(
        out_tif, "w",
        driver="GTiff",
        height=height, width=width,
        count=4, dtype="uint8",
        crs=CRS_RASTER, transform=transform,
        photometric="RGB", alpha="unspecified",
        compress="deflate",
    ) as dst:
        for b in range(4):
            dst.write(rgba[:, :, b], b + 1)

    # PNG preview (same RGBA image)
    from PIL import Image
    out_png = os.path.join(OUTPUT_DIR, f"heatmap_{nome}_reds.png")
    Image.fromarray(rgba, "RGBA").save(out_png)

    log(f"  themed {nome}: single-band false color '{PALETTE}' "
        f"-> {os.path.basename(out_tif)} + {os.path.basename(out_png)}")


# =========================================================================
# MAIN
# =========================================================================
def main():
    if not RAW_DATA or not os.path.isdir(RAW_DATA):
        raise FileNotFoundError(
            "Folder data_separati/raw_data not found by walking up from "
            + BASE_DIR
        )
    log(f"Separated data: {RAW_DATA}")
    log(f"Output:        {OUTPUT_DIR}")
    log(f"Raster parameters: CRS={CRS_RASTER} | cell={RES_METRI:.0f}m | "
        f"dtype={DTYPE_OUT} | -add | palette={PALETTE}")

    # Detect which modalities exist
    presenti = [m for m in MODALITA
                if os.path.isdir(os.path.join(RAW_DATA, m))]
    if not presenti:
        raise FileNotFoundError("No bus/metro/tram folder found.")
    log(f"Detected modalities: {', '.join(presenti)}")

    gdf_per_modalita = {}

    # --- Heatmap per single modality ---
    for m in presenti:
        log(f"=== MODALITY: {m} ===")
        cartella = os.path.join(RAW_DATA, m)
        gdf = shape_con_frequenza(cartella)
        if gdf.empty:
            log(f"  [warn] {m}: no shape with freq, skipping")
            continue
        gdf_per_modalita[m] = gdf
        arr, transform, _ = rasterizza_add(gdf, m)
        tematizza_reds(arr, transform, m)

    if len(gdf_per_modalita) >= 2:
        log("=== UNION (bus + metro + tram present) ===")
        gdf_unione = gpd.GeoDataFrame(
            pd.concat(gdf_per_modalita.values(), ignore_index=True),
            crs=CRS_RASTER,
        )
        log(f"  total shapes in the union: {len(gdf_unione)}")
        arr, transform, _ = rasterizza_add(gdf_unione, "unione")
        tematizza_reds(arr, transform, "unione")
    else:
        log("=== UNION skipped: only one service present "
            "(the single mode's heatmap is already the final one) ===")

    # Summary of produced files
    prodotti = sorted(f for f in os.listdir(OUTPUT_DIR)
                      if f.startswith("heatmap_"))
    log("Files produced in output/:")
    for f in prodotti:
        log("  - " + f)
    log("DONE.")


if __name__ == "__main__":
    main()

    try:
        import importlib.util
        _clip_path = os.path.join(BASE_DIR, "5b_clip_heatmaps_to_boundary.py")
        _spec = importlib.util.spec_from_file_location("_clip_heatmap_confine", _clip_path)
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        _mod.main()
    except Exception as _e:
        log(f"[warn] heatmap clipping on the boundary (step 5b) failed: {_e}")
