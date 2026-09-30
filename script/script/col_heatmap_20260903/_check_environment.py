# -*- coding: utf-8 -*-
"""Environment check: GDAL python, gdal_rasterize CLI, rasterio, geopandas."""
import shutil, importlib

def has_mod(m):
    try:
        importlib.import_module(m); return True
    except Exception as e:
        return f"NO ({e.__class__.__name__})"

print("geopandas :", has_mod("geopandas"))
print("rasterio  :", has_mod("rasterio"))
print("osgeo.gdal:", has_mod("osgeo.gdal"))
print("matplotlib:", has_mod("matplotlib"))
print("PIL       :", has_mod("PIL"))
print("gdal_rasterize CLI:", shutil.which("gdal_rasterize"))
print("gdaldem CLI       :", shutil.which("gdaldem"))
