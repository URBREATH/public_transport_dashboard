# -*- coding: utf-8 -*-
"""
_common.py - Shared configuration of the Leuven frequency heatmap pipeline.
It is not a pipeline step: it only contains paths and constants used by the scripts
"""
import os                                             # to handle paths and folders

# --- Folders (ROBUST to the folder position) --------------------------------
# This file now lives in pipe_completa/script/script_heatmap_freq/. The raw
# GTFS data and the LAU boundary are SHARED with pipe_completa (in
# pipe_completa/data/ and data/dati_grezzi/) to avoid duplicating hundreds of MB.
# The dashboard assets folder is found by WALKING UP the tree until
# 'frontend/src/assets' is met, so it works at any depth.
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))   # folder where this file is located


def _trova_su(nome_relativo, start=BASE_DIR, max_risalite=8):
    """Walks up the tree looking for the first folder that contains nome_relativo."""
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


_PIPE_DATA = (
    _trova_su(os.path.join("data", "raw_data"))
    or _trova_su(os.path.join("data_separati", "raw_data"))
)
if _PIPE_DATA:
    # raw data SHARED with pipe_completa (data_separati/raw_data)
    RAW_DIR = _PIPE_DATA
    _PIPE_ROOT = os.path.dirname(os.path.dirname(_PIPE_DATA))   # .../pipe_completa
    OUTPUT_DIR = os.path.join(_PIPE_ROOT, "output", "heatmap")  # heatmap output inside the shared output
else:
    # fallback: historical behavior (local folder)
    RAW_DIR    = os.path.join(BASE_DIR, "dati_grezzi")
    OUTPUT_DIR = os.path.join(BASE_DIR, "output")

CONFINE_GEOJSON = os.path.join(BASE_DIR, "confini_leuven.geojson")  # (legacy) boundary GeoJSON file
# Leuven boundary provided as a LAU Eurostat GeoPackage (already filtered on Leuven).
# I look first in the shared data/, then in the raw data, finally a local fallback.
_lau_condiviso = _trova_su(os.path.join("data", "lau_eurostat.gpkg"))
CONFINE_GPKG    = _lau_condiviso or os.path.join(RAW_DIR, "lau_eurostat.gpkg")

def _rileva_layer_confine(gpkg_path, default="lau_eurostat"):
    try:
        import pyogrio
        layers = pyogrio.list_layers(gpkg_path)
        if layers is not None and len(layers) > 0:
            return str(layers[0][0])
    except Exception:
        pass
    return default

CONFINE_LAYER   = _rileva_layer_confine(CONFINE_GPKG)               # city polygon layer (auto)

os.makedirs(OUTPUT_DIR, exist_ok=True)                # create the output folder if it doesn't exist

# --- Raw GTFS files ---
F_TRIPS          = os.path.join(RAW_DIR, "trips.txt")            # trips
F_SHAPES         = os.path.join(RAW_DIR, "shapes.txt")          # shape geometry points
F_ROUTES         = os.path.join(RAW_DIR, "routes.txt")          # lines/routes
F_CALENDAR       = os.path.join(RAW_DIR, "calendar.txt")        # base service calendar
F_CALENDAR_DATES = os.path.join(RAW_DIR, "calendar_dates.txt")  # calendar exceptions
F_FREQUENCIES =  os.path.join(RAW_DIR,"frequencies.txt")
# --- Intermediate / final outputs (in the output/ folder) ---
GPKG_CONFINE          = os.path.join(OUTPUT_DIR, "confine_leuven.gpkg")      # merged boundary (step 1)
GPKG_SHAPE            = os.path.join(OUTPUT_DIR, "shape.gpkg")               # step 2 (required intermediate)
CSV_FREQ_SHAPE        = os.path.join(OUTPUT_DIR, "frequenza_shape.csv")      # step 3
GPKG_SHAPE_FREQ       = os.path.join(OUTPUT_DIR, "shape_con_frequenza.gpkg") # step 4 (required intermediate)
# --- NEW pipeline WITHOUT OSM (direct aggregation from the shapes) ---
GPKG_CORRIDOI         = os.path.join(OUTPUT_DIR, "corridoi_shape.gpkg")      # step 5 (corridor aggregation)
GPKG_ARCHI_NODI       = os.path.join(OUTPUT_DIR, "archi_nodi.gpkg")          # step 6 (node/edge segmentation)
GPKG_FINALE           = os.path.join(OUTPUT_DIR, "heatmap_frequenze_leuven.gpkg") # step 7 (FINAL)

# --- Output per la DASHBOARD web (step 9) ------------------------------------
# GeoJSON that the Angular dashboard loads as the "Heatmap frequency" layer
# (layer id: heatmap_lines_freq). It must be regenerated on each pipeline run and
# then requires a new Angular build (ng build) to end up in the served dist/.
ASSETS_DASHBOARD_DIR  = (_trova_su(os.path.join("frontend", "src", "assets"))
                         or os.path.abspath(os.path.join(
                             BASE_DIR, "..", "..", "frontend", "src", "assets")))  # dashboard assets folder
GEOJSON_DASHBOARD     = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_strade.geojson")

# --- Output RASTER HEATMAP (step 10) -----------------------------------------
# RGBA PNG raster of the DAILY frequency heatmap, clipped to only the areas
# covered by the shapes (transparent elsewhere). Loaded by the dashboard as a
# Leaflet imageOverlay. The click is handled by a lightweight GeoJSON of cells
# (only where freq_giornaliera > 0) overlaid and invisible.
RASTER_PNG            = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_raster.png")
RASTER_BOUNDS_JSON    = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_raster_bounds.json")
RASTER_CELLE_GEOJSON  = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_raster_celle.geojson")
# Local copies (in output/) of the PNG and bounds for preview/debug before the deploy
RASTER_PNG_OUT        = os.path.join(OUTPUT_DIR, "heatmap_freq_raster.png")
RASTER_BOUNDS_OUT     = os.path.join(OUTPUT_DIR, "heatmap_freq_raster_bounds.json")

# Raster cell size in METERS (grid in EPSG:31370).
# 8 m = a good detail/weight tradeoff. The border smoothness NO longer depends
# on the cell fineness but on the strong SUPERSAMPLING + ANTIALIASING
# applied in step 10 (which removes the "staircase" effect from the borders).
RASTER_CELLA_METRI    = 8.0
# Number of "dilation" cells to make the lines visible as bands (not 1px).
RASTER_DILATA_CELLE   = 1

# --- NEW LAYER: 5x5 m SQUARE GRID (step 12) ---------------------------------
# Second "Heatmap frequency" layer made of SHARP 5x5 m SQUARES that follow the
# road shapes (like the current raster heatmap but with real squares,
# clickable, ONLY where the shapes are). Unlike the PNG raster (step 10)
# this is a GeoJSON of POLYGONS (one square per populated cell), colored with
# the SAME white->dark red palette and with the INTEGER daily frequency
# (rounded UP, math.ceil). On click it shows the int daily freq.
GRID5M_CELLA_METRI    = 5.0    # square side in meters (metric EPSG grid)
# Dilation (in cells) of the buffer around the shapes to select the 5x5 cells
# whose area is covered by a road. With smaller cells (5m) I keep the buffer
# narrow and centered (half-width ~ half a cell) to stay adherent.
GRID5M_SEMILARGHEZZA_METRI = 5.0   # road band half-width (m): covers ~1 cell per side
# Destination GeoJSON (dashboard assets + local copy in output/).
GRID5M_GEOJSON        = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_grid5m.geojson")
GRID5M_GEOJSON_OUT    = os.path.join(OUTPUT_DIR, "heatmap_freq_grid5m.geojson")

# the "Heatmap" 
# frequency 5x5" layer has TWO levels of detail (LOD):
#   - FROM AFAR: a PNG RASTER (the "photo" of the squares) always visible,
#     large and NOT clickable, generated from the SAME acc[] matrix of the squares
#     (same palette/colors), so it is identical to the squares but very light.
#   - FROM CLOSE (high zoom): the PNG disappears and the real 5x5 squares appear
#     (with a visible border, clickable). This is handled by the dashboard.
# Here the pipeline PRODUCES the PNG + its bounds JSON, AUTOMATICALLY.
GRID5M_PNG            = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_grid5m_raster.png")
GRID5M_BOUNDS_JSON    = os.path.join(ASSETS_DASHBOARD_DIR, "heatmap_freq_grid5m_bounds.json")
GRID5M_PNG_OUT        = os.path.join(OUTPUT_DIR, "heatmap_freq_grid5m_raster.png")
GRID5M_BOUNDS_OUT     = os.path.join(OUTPUT_DIR, "heatmap_freq_grid5m_bounds.json")

# Daily service hours used to derive the hourly frequency
# (freq_oraria = freq_giornaliera / ORE_SERVIZIO_GIORNO).
ORE_SERVIZIO_GIORNO   = 18

# --- CRS ---
CRS_WGS84   = "EPSG:4326"    # GTFS data (lat/lon) and OSM

# AUTOMATIC METRIC CRS (city-agnostic): NO longer hardcoded for a single
# city. It is DERIVED from the boundary data/lau_eurostat.gpkg: the right UTM
# zone is estimated from the municipality centroid, so buffers/tolerances/distances
# in meters are correct for ANY city in the world (Leuven -> UTM 31N, Madrid ->
# UTM 30N, etc). If something goes wrong a reasonable fallback is used (UTM WGS84).
def _crs_metrico_auto(default="EPSG:32631"):
    """Returns the 'EPSG:<code>' string of the UTM zone suitable for the city boundary."""
    try:
        import geopandas as gpd
        gdf = gpd.read_file(CONFINE_GPKG, layer=CONFINE_LAYER)
        if gdf.crs is None:
            gdf = gdf.set_crs(4326)
        gdf = gdf.to_crs(4326)
        # 1) via geopandas (preferred): estimate the UTM CRS from the data
        try:
            utm = gdf.estimate_utm_crs()
            code = utm.to_epsg()
            if code:
                return f"EPSG:{code}"
        except Exception:
            pass
        # 2) manual fallback via centroid -> UTM WGS84 zone
        c = gdf.geometry.union_all().centroid
        lon, lat = float(c.x), float(c.y)
        zone = int((lon + 180) // 6) + 1
        epsg = (32600 if lat >= 0 else 32700) + zone
        return f"EPSG:{epsg}"
    except Exception:
        return default

CRS_METRICO = _crs_metrico_auto()   # AUTO from the boundary (distances/buffers/tolerances in meters)

# --- Analysis parameters ---
TOLLERANZA_METRI   = 5.0     # tolerance to associate shape -> street edge
N_SOGLIE_TEMATICHE = 5       # color classes yellow -> dark red

# 5-class palette light yellow -> dark red (YlOrRd) - used for the "classic" legend
PALETTE_5 = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"]

# CONTINUOUS MANY-stop HEATMAP palette: WHITE (lowest frequency in absolute terms)
# -> VERY DARK RED (highest frequency in absolute terms), with a monotonic
# gradient from white to red passing through pink/light red -> red -> dark
# red. Sequential and readable scale (no blue/green/yellow): more passages
# = darker. Many stops = smooth and continuous transition.
PALETTE_HEATMAP = [
    "#ffffff",  # white  - fewest passages in absolute terms
    "#fff0e8",
    "#fdd8c7",
    "#fcbba1",
    "#fc9877",
    "#fb7551",
    "#f45435",
    "#e02f21",
    "#c00f14",
    "#96000c",
    "#66000a",
    "#3d0006",  # very dark red - most passages in absolute terms
]

def log(msg):
    # Single log function: prints the message prefixed by the name of the running script
    print(f"[{os.path.basename(__import__('sys').argv[0])}] {msg}", flush=True)
