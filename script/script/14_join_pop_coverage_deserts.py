# -*- coding: utf-8 -*-

import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _pipe as P
data, out, riepilogo = P.data, P.out, P.riepilogo
import geopandas as gpd
import pandas as pd


CRS_METRICO = 25830


def _leggi(path, assumo_3857_se_manca=True):
    gdf = gpd.read_file(path)
    if gdf.crs is None and assumo_3857_se_manca:
        gdf.set_crs(3857, inplace=True)
    return gdf


def main():
    src_cov = P.data_any("pop_coverage_map.gpkg", "pop_coverage.gpkg", "population_coverage.gpkg")
    src_pop = out("pop_2025_cells.geojson")

    if not os.path.exists(src_pop):
        print("ERROR: missing output/pop_2025_cells.geojson (run step 03_4 first).")
        sys.exit(1)

    print("STEP 05b . Spatial join population <-> coverage")

    cov = _leggi(src_cov).to_crs(CRS_METRICO).reset_index(drop=True)
    pop = _leggi(src_pop, assumo_3857_se_manca=False).to_crs(CRS_METRICO).reset_index(drop=True)

    # normalize the pop field of the GHSL cells
    if "pop" not in pop.columns:
        print("ERROR: the population cells do not have the 'pop' field.")
        sys.exit(1)
    pop["pop"] = pd.to_numeric(pop["pop"], errors="coerce").fillna(0.0)

    # points = centroids of the population cells (100x100 m)
    pts = pop.copy()
    pts["geometry"] = pts.geometry.centroid
    pts = pts[["pop", "geometry"]]

    print("  population cells:", len(pts), "| total pop:", int(pts["pop"].sum()))
    print("  coverage cells:", len(cov))

    # ---------------------------------------------------------------
    # 1) JOIN population -> COVERAGE (sum pop per coverage cell)
    # ---------------------------------------------------------------
    cov["_covid"] = range(len(cov))
    j_cov = gpd.sjoin(pts, cov[["_covid", "geometry"]], how="inner", predicate="within")
    pop_per_cov = j_cov.groupby("_covid")["pop"].sum()

    cov["pop_tot"] = cov["_covid"].map(pop_per_cov).fillna(0.0)

    # pct_covered expected in 0..100
    if "pct_covered" not in cov.columns:
        print("WARNING: coverage without pct_covered, assuming 0.")
        cov["pct_covered"] = 0.0
    cov["pct_covered"] = pd.to_numeric(cov["pct_covered"], errors="coerce").fillna(0.0)

    cov["pop_covered"] = (cov["pop_tot"] * cov["pct_covered"] / 100.0).round().astype(int)
    cov["pop_tot"] = cov["pop_tot"].round().astype(int)
    cov["pop_uncovered"] = (cov["pop_tot"] - cov["pop_covered"]).clip(lower=0).astype(int)

    tot_res = int(cov["pop_tot"].sum())
    tot_cov = int(cov["pop_covered"].sum())
    tot_unc = int(cov["pop_uncovered"].sum())
    print(f"  COVERAGE: residents in cells = {tot_res} | covered = {tot_cov} | uncovered = {tot_unc}")

    cov = cov.drop(columns=["_covid"])

    # ---------------------------------------------------------------
    # 3) Export coverage in WGS84 (EPSG:4326) for the dashboard
    # ---------------------------------------------------------------
    cov_out = cov.to_crs(4326)

    dst_cov = out("population_coverage.geojson")

    # NaN -> None cleanup on non-geometric fields
    for c in cov_out.columns:
        if c == "geometry":
            continue
        try:
            cov_out[c] = cov_out[c].where(cov_out[c].notna(), None)
        except Exception:
            pass

    if os.path.exists(dst_cov):
        os.remove(dst_cov)
    cov_out.to_file(dst_cov, driver="GeoJSON")

    with open(dst_cov, "r", encoding="utf-8") as f:
        n_cov = len(json.load(f).get("features", []))

    riepilogo(coverage_feat=n_cov,
              residenti=tot_res, coperti=tot_cov, scoperti=tot_unc)
    print("OK -> output/population_coverage.geojson (+pop_tot/pop_covered/pop_uncovered)")


if __name__ == "__main__":
    main()
