# -*- coding: utf-8 -*-

import os, sys, math, urllib.request, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, riepilogo = P.data, P.riepilogo
import geopandas as gpd

# Population data folder (created automatically): raw/extracted GHSL tif
OUT = data("popolazione", "ghsl")
os.makedirs(OUT, exist_ok=True)

ROOT = ("https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
        "GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/tiles/")
NAME = "GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0_R{r}_C{c}.zip"

# --- Official GHSL R2023A grid in WGS84 (EPSG:4326) ---
# The 4326_3ss tiles cover 10 degrees per side. Origin (top-left corner):
#   lon(C=1) = -180 degrees ; lat(R=1) = +90 degrees ; TILE = 10 degrees.
WGS84 = "EPSG:4326"
TILE_DEG = 10.0
LON0 = -180.0   # left edge (west) of column 1
LAT0 =   90.0   # top edge (north) of row 1
MARGINE_DEG = 0.03     # safety margin in degrees (~3 km) so as not to cut the edges


def tasselli_dal_confine():
    """Computes the list (r, c) of GHSL tiles (10-degree WGS84 grid) that
    cover the boundary + margin. The boundary is already (or reprojected) in EPSG:4326."""
    gpkg = data("lau_eurostat.gpkg")
    if not os.path.exists(gpkg):
        # fallback: historical behavior (Leuven tiles) if the boundary is missing
        print("WARNING: lau_eurostat.gpkg not found, using the default tiles.")
        return [(4, 19)]
    g = gpd.read_file(gpkg).dissolve().to_crs(WGS84)
    minx, miny, maxx, maxy = g.total_bounds  # lon/lat in degrees
    minx -= MARGINE_DEG; miny -= MARGINE_DEG; maxx += MARGINE_DEG; maxy += MARGINE_DEG
    c_min = int(math.floor((minx - LON0) / TILE_DEG)) + 1
    c_max = int(math.floor((maxx - LON0) / TILE_DEG)) + 1
    r_min = int(math.floor((LAT0 - maxy) / TILE_DEG)) + 1
    r_max = int(math.floor((LAT0 - miny) / TILE_DEG)) + 1
    tiles = sorted({(r, c) for r in range(r_min, r_max + 1)
                           for c in range(c_min, c_max + 1)})
    print("Boundary bbox WGS84 (degrees):", [round(v, 4) for v in (minx, miny, maxx, maxy)])
    return tiles


candidates = tasselli_dal_confine()

print("STEP 03.1 - Download GHS-POP 2025 3ss/WGS84 tiles (current city)")
print("Required tiles:", candidates)

# Cleanup: remove tif/zip of previous cities (tiles no longer needed),
# so the step 03.2 mosaic uses ONLY the tiles of the current city.
import glob as _glob
import re as _re
_needed = {(r, c) for (r, c) in candidates}
for _f in _glob.glob(os.path.join(OUT, "GHS_POP_E2025_*_R*_C*.*")):
    _m = _re.search(r"_R(\d+)_C(\d+)", os.path.basename(_f))
    if _m and (int(_m.group(1)), int(_m.group(2))) not in _needed:
        try:
            os.remove(_f)
            print("  removed obsolete tile:", os.path.basename(_f))
        except Exception:
            pass


def try_download(r, c):
    fn = NAME.format(r=r, c=c)
    url = ROOT + fn
    dest = os.path.join(OUT, fn)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
        with open(dest, "wb") as f:
            f.write(payload)
        return dest, len(payload)
    except Exception as e:
        return None, str(e)


ok = []
for (r, c) in candidates:
    dest, info = try_download(r, c)
    if dest:
        print(f"OK  R{r}_C{c}: {info/1024/1024:.2f} MB -> {os.path.basename(dest)}")
        try:
            with zipfile.ZipFile(dest) as z:
                tifs = [n for n in z.namelist() if n.lower().endswith(".tif")]
                for t in tifs:
                    z.extract(t, OUT)
                    print(f"    extracted: {t}")
                ok.append((r, c, tifs))
        except Exception as e:
            print(f"    unzip error: {e}")
    else:
        print(f"KO  R{r}_C{c}: {info[:120]}")

riepilogo(tasselli_ok=len(ok), cartella="data/popolazione/ghsl")
for f in os.listdir(OUT):
    print("   ", f, os.path.getsize(os.path.join(OUT, f)))
