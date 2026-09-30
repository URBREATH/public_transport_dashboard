# -*- coding: utf-8 -*-

import geopandas as gpd                              # library to handle geographic data (GeoDataFrame)
from shapely.ops import unary_union                  # function to merge multiple geometries into one
from shapely.geometry import mapping, shape          # geometry conversion utilities (support import)
import _common as C                                  # internal module with shared paths and constants


def main():
    # Log of the input file I'm about to read
    C.log(f"Reading geometry from {C.CONFINE_GPKG} (layer '{C.CONFINE_LAYER}')")
    # Load the LAU GeoPackage (already filtered on Leuven) into a GeoDataFrame
    gdf = gpd.read_file(C.CONFINE_GPKG, layer=C.CONFINE_LAYER)
    if gdf.crs is None:
        # If the file has no CRS defined, assign it (WGS84)
        gdf = gdf.set_crs(C.CRS_WGS84)
    else:
        # Otherwise reproject everything to WGS84 for uniformity
        gdf = gdf.to_crs(C.CRS_WGS84)
    # Check log: how many features and of what geometry type they are
    C.log(f"Features read: {len(gdf)} | types: {gdf.geom_type.unique().tolist()}")

    # Union of all geometries -> single boundary polygon
    confine = unary_union(gdf.geometry.values)
    # Cleanup with buffer(0) for any invalid geometries
    if not confine.is_valid:
        # buffer(0) is a standard trick to "repair" invalid geometries
        confine = confine.buffer(0)

    # Build an output GeoDataFrame with a single row (the merged boundary)
    out = gpd.GeoDataFrame({"id": [1]},
                           geometry=[confine], crs=C.CRS_WGS84)

    # indicative area in km2 (in metric CRS)
    # reproject to the metric CRS, take the area of the first (only) element and convert m2 -> km2
    area_km2 = out.to_crs(C.CRS_METRICO).area.iloc[0] / 1e6
    # Summary log: estimated area and resulting geometry type
    C.log(f"Boundary merged. Area ~ {area_km2:.2f} km2 | type: {out.geom_type.iloc[0]}")

    # Save the boundary into the output GeoPackage, layer 'confine'
    out.to_file(C.GPKG_CONFINE, layer="confine", driver="GPKG")
    C.log(f"Saved -> {C.GPKG_CONFINE} (layer 'confine')")


if __name__ == "__main__":
    # Run main() only if the script is launched directly
    main()
