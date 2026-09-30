# -*- coding: utf-8 -*-
"""
run_pipeline.py - ORCHESTRATOR of the full Leuven 15-min pipeline.

Runs in sequence all steps 01..08 (each as an isolated subprocess, with its
own progress bar), then INVOKES the modality heatmap sub-pipeline that lives
INSIDE pipe_completa/script/col_heatmap_20260903/ (per-mode heatmap
bus/metro/tram/union). This is the ONLY active heatmap of the dashboard: step
6 publishes the outputs into pipe_completa/output/ and into the frontend assets.

Usage:
    python run_pipeline.py                 # runs everything (01..08 + heatmap)
    python run_pipeline.py --solo 06 07    # runs only some steps (by prefix)
    python run_pipeline.py --no-heatmap    # runs 01..08 but skips the heatmap
    python run_pipeline.py --from 06       # runs from step 06 onwards
    python run_pipeline.py --stop-on-error # stops at the first error (default: continues)

At the end (if --solo is NOT used) it ALWAYS runs a VALIDATION of the outputs
(_validate_output.py): it checks that every file/folder expected by the dashboard
exists and is NOT empty/degenerate (e.g. GeoJSON with 0 features). If a CRITICAL
output is missing or empty, the pipeline exits with a code != 0 and prints which
files are the problem. This way, whatever GTFS data is put in data/, you know
immediately whether the output is really USABLE for the dashboard.
"""
import os
import sys
import glob
import time
import argparse
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))          # .../pipe_completa/script
ROOT_DIR = os.path.dirname(SCRIPT_DIR)                           # .../pipe_completa
OUTPUT_DIR = os.path.join(ROOT_DIR, "output")                   # shared output


PYEXE = sys.executable  # orchestrator interpreter (for steps 01..08)

HEATMAP_MOD_DIR = os.path.join(SCRIPT_DIR, "col_heatmap_20260903")

HEATMAP_MOD_STEP = [
    "1_estrai_confine.py",
    "5_genera_heatmap_modalita.py",
    "7_calcola_soglie_jenks.py",
    "6_deploy_heatmap_assets.py",
]


def esegui_heatmap_modalita():
    """Runs in sequence steps 1..6 of col_heatmap_20260903 (per-mode heatmap
    bus/metro/tram/union). Step 6 copies the outputs into
    pipe_completa/output/ and into the frontend assets. Returns (ok, seconds)."""
    if not os.path.isdir(HEATMAP_MOD_DIR):
        print(f"[heatmap_mod] Folder not found, skipping: {HEATMAP_MOD_DIR}", flush=True)
        return False, 0.0
    t0 = time.time()
    ok_tutti = True
    for s in HEATMAP_MOD_STEP:
        path = os.path.join(HEATMAP_MOD_DIR, s)
        if not os.path.exists(path):
            print(f"[heatmap_mod] missing step, skipping: {s}", flush=True)
            continue
        print(f"\n[heatmap_mod] STEP {s}", flush=True)
        r = subprocess.run([PYEXE, path], cwd=HEATMAP_MOD_DIR)
        if r.returncode != 0:
            print(f"[heatmap_mod] ERROR in step {s} (code {r.returncode}).", flush=True)
            ok_tutti = False
            break
    return ok_tutti, time.time() - t0


def scopri_step():
    """
    Finds the step scripts NN[letter][_...].py (00..09, including the variants
    with a letter like 05b, 08b, 08c), sorted in a NATURAL and CORRECT way.

    NB: the old pattern '[0-9][0-9]_*.py' required a '_' right after the two
    digits, so it silently EXCLUDED fundamental steps like:
      - 05b_join_pop_coverage_deserts.py
      - 08b_ottimizza_transport15.py   (generates output/transport_15min.geojson
                                        with the 'transport_stop' field -> the
                                        "15 min transport" layer gets COLORED)
      (NB 2026-09-02: the step 08c_split_transport_tiles.py was ARCHIVED
       as __08c_... because the frontend now uses the PURE transport_15min.geojson,
       without transport_tiles tiles.)
    The result was that those layers stayed broken/empty even when running the
    pipeline. Now the pattern accepts an optional letter after the digits.

    The ordering is by (number, letter, rest) so 08 comes BEFORE 08b/08c.
    """
    import re
    tutti = glob.glob(os.path.join(SCRIPT_DIR, "[0-9][0-9]*.py"))
    nomi = [os.path.basename(p) for p in tutti]

    def chiave(nome):
        m = re.match(r"^(\d{2})([a-z]?)", nome)
        if not m:
            return (99, "", nome)
        return (int(m.group(1)), m.group(2), nome)

    nomi = [n for n in nomi if not n.startswith("_")]
    nomi = [n for n in nomi if not n.startswith("99_")]
    return sorted(nomi, key=chiave)  # sort by (number, letter, rest)




def barra(txt):
    print("\n" + "=" * 78, flush=True)
    print("  " + txt, flush=True)
    print("=" * 78, flush=True)


def esegui_step(nome_file):
    """Runs a step script 01..08 as a subprocess; returns (ok, seconds)."""
    path = os.path.join(SCRIPT_DIR, nome_file)
    t0 = time.time()
    proc = subprocess.run([PYEXE, path], cwd=SCRIPT_DIR)
    dt = time.time() - t0
    return proc.returncode == 0, dt


def main():
    ap = argparse.ArgumentParser(description="Leuven 15-min pipeline orchestrator")
    ap.add_argument("--solo", nargs="*", default=None,
                    help="Runs only the steps whose name starts with these prefixes (e.g. 06 07)")
    ap.add_argument("--from", dest="da", default=None,
                    help="Runs from the step with the given prefix onwards (e.g. 06)")
    ap.add_argument("--no-heatmap", action="store_true",
                    help="Skips the heatmap sub-pipeline")
    ap.add_argument("--stop-on-error", action="store_true",
                    help="Stops at the first failed step (default: continues)")
    args = ap.parse_args()

    step = scopri_step()
    if not step:
        print("No step NN_*.py found in", SCRIPT_DIR)
        sys.exit(1)

    if args.solo:
        step = [s for s in step if any(s.startswith(p) for p in args.solo)]
    elif args.da:
        idx = next((i for i, s in enumerate(step) if s.startswith(args.da)), 0)
        step = step[idx:]

    barra(f"LEUVEN 15-MIN PIPELINE . {len(step)} steps to run")
    for i, s in enumerate(step, 1):
        print(f"  {i:2d}. {s}", flush=True)

    esiti = []
    for i, s in enumerate(step, 1):
        barra(f"STEP {i}/{len(step)} . {s}")
        ok, dt = esegui_step(s)
        esiti.append((s, ok, dt))
        print(f"\n[{'OK' if ok else 'ERROR'}] {s}  ({dt:.1f}s)", flush=True)
        if not ok and args.stop_on_error:
            print(">> Stopping (--stop-on-error).", flush=True)
            break

    if not args.no_heatmap and (not args.solo):
        barra("SUB-PIPELINE . col_heatmap_20260903 (per-modality heatmap)")
        ok, dt = esegui_heatmap_modalita()
        esiti.append(("col_heatmap_20260903", ok, dt))
        print(f"\n[{'OK' if ok else 'ERROR'}] heatmap_modalita  ({dt:.1f}s)", flush=True)


    if not args.solo:
        sync = os.path.join(SCRIPT_DIR, "99_sync_assets.py")
        if os.path.exists(sync):
            barra("DEPLOY ASSETS -> frontend/src/assets (99_sync_assets)")
            t0 = time.time()
            r = subprocess.run([PYEXE, sync], cwd=SCRIPT_DIR)
            esiti.append(("99_sync_assets.py", r.returncode == 0, time.time() - t0))



    output_valido = True
    if not args.solo:
        barra("DASHBOARD OUTPUT VALIDATION")
        try:
            import _validate_output as V
            output_valido, _problemi = V.valida(verbose=True)
        except Exception as e:
            print(f"[validation] ERROR while running the validation: {e}", flush=True)
            output_valido = False

    barra("FINAL SUMMARY")
    tot = 0.0
    for s, ok, dt in esiti:
        tot += dt
        print(f"  {'OK   ' if ok else 'FAILED'}  {s:45s} {dt:7.1f}s", flush=True)
    print("-" * 78, flush=True)
    print(f"  Total time: {tot:.1f}s . steps OK: "
          f"{sum(1 for _s, ok, _d in esiti if ok)}/{len(esiti)}", flush=True)
    if not args.solo:
        print(f"  Dashboard output: "
              f"{'USABLE' if output_valido else 'NOT USABLE (see above)'}",
              flush=True)

    # Exits with an error if any step failed OR if the final output
    # validation did not pass.
    if any(not ok for _s, ok, _d in esiti) or not output_valido:
        sys.exit(2)


if __name__ == "__main__":
    main()
