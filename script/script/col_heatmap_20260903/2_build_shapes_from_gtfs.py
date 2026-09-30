# -*- coding: utf-8 -*-
"""
STEP 2 - Build the shape geometries from the GTFS data (shapes.txt).
Each shape_id -> a LineString ordered by shape_pt_sequence.
REQUIRED INTERMEDIATE OUTPUT: output/shape.gpkg (layer 'shape'),
a single layer with ALL the overlapping shapes. CRS 4326.
"""
import pandas as pd                                  # to read/manipulate the shapes.txt table
import geopandas as gpd                              # to create the shapes GeoDataFrame
from shapely.geometry import LineString              # to build the lines from the points
import _common as C                                  # shared paths and constants


def main():
    # Log: about to read the (large) file of shape points
    C.log(f"Reading {C.F_SHAPES} (may take a while, ~1.35M rows)")
    # Read only the needed columns; shape_id as string to not lose leading zeros
    df = pd.read_csv(
        C.F_SHAPES,
        dtype={"shape_id": str},
        usecols=["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
    )
    # Convert latitude to numeric (invalid values -> NaN)
    df["shape_pt_lat"] = pd.to_numeric(df["shape_pt_lat"], errors="coerce")
    # Convert longitude to numeric
    df["shape_pt_lon"] = pd.to_numeric(df["shape_pt_lon"], errors="coerce")
    # Convert the point sequence to numeric
    df["shape_pt_sequence"] = pd.to_numeric(df["shape_pt_sequence"], errors="coerce")
    # Drop the rows with missing values in the key columns
    df = df.dropna(subset=["shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])

    # Sort by shape and sequence
    # (essential: the points must be connected in the right order to form the line)
    df = df.sort_values(["shape_id", "shape_pt_sequence"])
    # Statistic log: number of points and number of distinct shapes
    C.log(f"Total points: {len(df)} | unique shapes: {df['shape_id'].nunique()}")

    # List that will collect one record (shape_id + geometry) per shape
    records = []
    # Group the points by shape_id (sort=False keeps the already-set order)
    for shape_id, g in df.groupby("shape_id", sort=False):
        # Build the list of coordinates (lon, lat) in the sequence order
        coords = list(zip(g["shape_pt_lon"], g["shape_pt_lat"]))
        if len(coords) < 2:
            # A LineString needs at least 2 points: if fewer, skip the shape
            continue
        # Add the record with the LineString geometry built from the points
        records.append({"shape_id": shape_id, "geometry": LineString(coords)})

    # Create the GeoDataFrame with all the shapes in CRS WGS84
    gdf = gpd.GeoDataFrame(records, crs=C.CRS_WGS84)
    C.log(f"Shapes geometrized: {len(gdf)}")

    # Save all the shapes into the intermediate GeoPackage, layer 'shape'
    gdf.to_file(C.GPKG_SHAPE, layer="shape", driver="GPKG")
    C.log(f"Saved -> {C.GPKG_SHAPE} (layer 'shape', all overlapping shapes)")


if __name__ == "__main__":
    # Run main() only if the script is launched directly
    main()
