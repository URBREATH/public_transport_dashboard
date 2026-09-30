# -*- coding: utf-8 -*-
"""
STEP 00 - Computes the BOUNDS of the municipal boundary (data/lau_eurostat.gpkg) and
writes them to output/city_bounds.json (EPSG:4326).

It is used to make the INITIAL VIEW of the Angular dashboard DATA-DRIVEN: at startup
the map does fitBounds on these bounds, so the whole area covered by
lau_eurostat.gpkg is fully visible regardless of the city (Leuven, Madrid, ...), without any
hardcoded center/zoom.

File format (Leaflet-compatible):
    {
      "bounds": [[south, west], [north, east]],   # [[latMin, lonMin], [latMax, lonMax]]
      "center": [lat, lon],
      "name": "<municipality name if available>"
    }
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out, riepilogo = P.data, P.out, P.riepilogo
import geopandas as gpd

src = data("lau_eurostat.gpkg")
dst = out("city_bounds.json")

print("STEP 00 . Compute municipal boundary bounds (city_bounds)")
gdf = gpd.read_file(src)
print("CRS in:", gdf.crs, "| n_feat:", len(gdf), "| geom:", gdf.geom_type.unique().tolist())

# Bring everything to EPSG:4326 (lat/lon) for Leaflet.
if gdf.crs is None:
    print("Missing CRS, assuming EPSG:3857.")
    gdf.set_crs(3857, inplace=True)
if str(gdf.crs).upper() not in ("EPSG:4326",):
    gdf = gdf.to_crs(4326)

# total_bounds = (minx, miny, maxx, maxy) = (lonMin, latMin, lonMax, latMax)
minx, miny, maxx, maxy = [float(v) for v in gdf.total_bounds]

# Leaflet wants [[south, west], [north, east]] = [[latMin, lonMin], [latMax, lonMax]]
bounds = [[miny, minx], [maxy, maxx]]
center = [(miny + maxy) / 2.0, (minx + maxx) / 2.0]


NAME_COLS = ("LAU_NAME", "lau_name", "NAME", "name", "GISCO_NAME", "COMM_NAME")


def _prima_col_nome(g):
    for col in NAME_COLS:
        if col in g.columns:
            return col
    return None


name = None
name_col = _prima_col_nome(gdf)
if name_col is not None:
    try:
        if len(gdf) == 1:
            # Only one feature: that's the name.
            val = gdf[name_col].dropna().astype(str)
            if len(val):
                name = val.iloc[0]
        else:
            try:
                gdf_m = gdf.to_crs(3857)
                centroide_m = gdf_m.geometry.union_all().centroid
                import geopandas as _gpd
                centroide = _gpd.GeoSeries([centroide_m], crs=3857).to_crs(4326).iloc[0]
            except Exception:
                centroide = gdf.geometry.union_all().centroid
            match = gdf[gdf.geometry.contains(centroide)]
            if len(match) == 0:
                # The centroid may fall outside concave geometries: take the
                # feature closest to the centroid.
                match = gdf.iloc[[gdf.geometry.distance(centroide).idxmin()]]
            val = match[name_col].dropna().astype(str)
            if len(val):
                name = val.iloc[0]
            else:
                # fallback: first feature with a valid name in the whole gdf
                allv = gdf[name_col].dropna().astype(str)
                if len(allv):
                    name = allv.iloc[0]
    except Exception as e:
        print("City name extraction failed:", e)
        name = None

payload = {"bounds": bounds, "center": center, "name": name}

if os.path.exists(dst):
    os.remove(dst)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)

riepilogo(feat=len(gdf), name=name,
          south=round(miny, 5), west=round(minx, 5),
          north=round(maxy, 5), east=round(maxx, 5))
print("OK -> output/city_bounds.json")
