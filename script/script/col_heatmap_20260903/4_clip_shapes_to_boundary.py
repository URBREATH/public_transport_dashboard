# -*- coding: utf-8 -*-
"""
STEP 4 - Clip the shapes on the Leuven boundary and attach the frequency.
- Takes output/shape.gpkg (geometries) + output/frequenza_shape.csv (freq).
- Clips each shape on the Leuven boundary: keep ONLY the portion inside the
  boundary (as required).
- REQUIRED INTERMEDIATE OUTPUT: output/shape_con_frequenza.gpkg (layer
  'shape_con_frequenza'): for each overlapping shape its freq_giornaliera.
"""
import pandas as pd                                  # to read the frequencies CSV
import geopandas as gpd                              # to handle shapes, boundary and clip
import _common as C                                  # shared paths and constants


def main():
    # Load the three inputs: shape geometries, frequencies and boundary
    C.log("Loading shapes, frequencies and boundary...")
    shapes = gpd.read_file(C.GPKG_SHAPE, layer="shape")                    # shape geometries
    freq = pd.read_csv(C.CSV_FREQ_SHAPE, dtype={"shape_id": str})          # frequencies per shape_id
    confine = gpd.read_file(C.GPKG_CONFINE, layer="confine").to_crs(C.CRS_WGS84)  # boundary in WGS84

    # frequency join
    # Attach to each shape its frequency via shape_id (left join to keep all shapes)
    shapes = shapes.merge(freq, on="shape_id", how="left")
    # Shapes without frequency get 0.0
    shapes["freq_giornaliera"] = shapes["freq_giornaliera"].fillna(0.0)
    # Same for the total passages (0 converted to integer)
    shapes["passaggi_totali"] = shapes["passaggi_totali"].fillna(0).astype(int)

    C.log(f"Total shapes before clip: {len(shapes)}")

    # Clip on the boundary (keeps only the portion inside Leuven)
    clipped = gpd.clip(shapes, confine)
    # remove any empty geometries resulting from the clip
    clipped = clipped[~clipped.geometry.is_empty & clipped.geometry.notna()]
    # keep only lines (the clip may generate points on tangencies)
    clipped = clipped[clipped.geom_type.isin(["LineString", "MultiLineString"])]

    # Statistic logs on the clipped shapes
    C.log(f"Shapes intersecting Leuven (clipped): {len(clipped)}")
    C.log(f"freq_giornaliera (clipped): min={clipped.freq_giornaliera.min():.3f} "
          f"max={clipped.freq_giornaliera.max():.3f}")

    # Reset the index after the filters and save the intermediate result
    clipped = clipped.reset_index(drop=True)
    clipped.to_file(C.GPKG_SHAPE_FREQ, layer="shape_con_frequenza", driver="GPKG")
    C.log(f"Saved -> {C.GPKG_SHAPE_FREQ} (layer 'shape_con_frequenza')")


if __name__ == "__main__":
    # Run main() only if the script is launched directly
    main()
