# -*- coding: utf-8 -*-

import os
import json

import numpy as np
import rasterio
import matplotlib
matplotlib.use("Agg")
import matplotlib.cm as cm
import matplotlib.colors as mcolors

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# Total = unione. Order: as it appears in the menu (Total, Metro, Tram, Bus).
MODI = [
    ("unione", "heatmap_unione.tif"),
    ("metro", "heatmap_metro.tif"),
    ("tram", "heatmap_tram.tif"),
    ("bus", "heatmap_bus.tif"),
]

N_CLASSI = 5
OUT_JSON = os.path.join(OUTPUT_DIR, "heatmap_freq_soglie.json")


def log(msg):
    print(f"[soglie_jenks] {msg}", flush=True)


def _colori_reds(n):
    """n HEX colors from the 'Reds' colormap (same palette as the _reds.tif).
    Compatible with recent matplotlib (colormaps[...]) and old (cm.get_cmap)."""
    try:
        cmap = matplotlib.colormaps["Reds"]          # matplotlib >= 3.7
    except Exception:
        cmap = cm.get_cmap("Reds")                    # matplotlib < 3.7
    # avoid the two too-light/too-dark extremes: sample in [0.20 .. 0.95]
    xs = np.linspace(0.20, 0.95, n)
    return [mcolors.to_hex(cmap(float(x))) for x in xs]


def _valori_validi(tif_path):
    with rasterio.open(tif_path) as ds:
        arr = ds.read(1).astype("float64")
        nod = ds.nodata
    v = arr.ravel()
    if nod is not None:
        v = v[v != nod]
    v = v[np.isfinite(v)]
    v = v[v > 0]  # empty cells / no service: excluded from the classification
    return v


def _jenks_breaks(vals, k):
    """Returns the k+1 bounds of the k Jenks classes (including min and max)."""
    try:
        import jenkspy
        # jenkspy wants a list; on large datasets I sample for speed
        data = vals
        if data.size > 200000:
            idx = np.random.RandomState(42).choice(data.size, 200000, replace=False)
            data = data[idx]
        breaks = jenkspy.jenks_breaks(data.tolist(), n_classes=k)
        return list(breaks), "jenks"
    except Exception as e:
        log(f"  jenkspy unavailable/error ({e}) -> using quantiles as fallback")
        qs = np.linspace(0, 100, k + 1)
        breaks = list(np.percentile(vals, qs))
        return breaks, "quantili_fallback"


def _classi_da_breaks(breaks, colori):

    b = [float(round(x)) for x in breaks]
    # ensure strict monotonicity
    for i in range(1, len(b)):
        if b[i] <= b[i - 1]:
            b[i] = b[i - 1] + 1
    n = len(b) - 1  # number of classes
    classi = []
    for i in range(n):
        lo = int(round(breaks[0])) if i == 0 else int(b[i]) + 1
        # last class: hi = the true real maximum of the raster
        hi = int(round(breaks[-1])) if i == n - 1 else int(b[i + 1])
        if hi < lo:
            hi = lo
        classi.append({
            "min": lo,
            "max": hi,
            "label": f"{lo}-{hi}",   # the last one too is "start-max"
            "color": colori[i],
        })
    return classi


def main():
    if not os.path.isdir(OUTPUT_DIR):
        log(f"ERROR: output folder not found: {OUTPUT_DIR}")
        raise SystemExit(1)

    colori = _colori_reds(N_CLASSI)
    metodo_globale = "jenks"
    modi_out = {}

    for nome, fname in MODI:
        tif = os.path.join(OUTPUT_DIR, fname)
        if not os.path.isfile(tif):
            log(f"  [skip] missing {fname} (modality {nome} not present)")
            continue
        vals = _valori_validi(tif)
        if vals.size == 0:
            log(f"  [warn] {fname}: no value > 0, skipping")
            continue
        vmin = float(np.min(vals))
        vmax = float(np.max(vals))
        breaks, metodo = _jenks_breaks(vals, N_CLASSI)
        if metodo != "jenks":
            metodo_globale = metodo
        classi = _classi_da_breaks(breaks, colori)
        modi_out[nome] = {
            "file": fname,
            "min": int(round(vmin)),
            "max": int(round(vmax)),
            "classi": classi,
        }
        log(f"  {nome}: min={int(vmin)} max={int(vmax)} breaks={[round(x) for x in breaks]}")

    if not modi_out:
        log("ERROR: no heatmap found in output/. Run step 5 first.")
        raise SystemExit(2)

    payload = {
        "metodo": metodo_globale,
        "classi_num": N_CLASSI,
        "modi": modi_out,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"DONE. Written {OUT_JSON} ({len(modi_out)} modes, method={metodo_globale})")


if __name__ == "__main__":
    main()
