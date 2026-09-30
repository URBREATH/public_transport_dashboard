import os
import subprocess
import sys

# Ricompila il progetto Angular ATTUALE (produzione) partendo dal sorgente
# in dashboard/frontend, cosi' la build riflette esattamente il codice corrente.

# Gli script sono stati spostati in dashboard/config/: si risale alla cartella padre
# (dashboard/) con un dirname in piu', perche' frontend/ sta li'.
FRONTEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")

# Su Windows ng sta in node_modules\.bin\ng.cmd
ng_cmd = os.path.join(FRONTEND, "node_modules", ".bin", "ng.cmd")
if not os.path.exists(ng_cmd):
    ng_cmd = os.path.join(FRONTEND, "node_modules", ".bin", "ng")

cmd = [ng_cmd, "build", "--configuration", "production"]
print("Eseguo:", " ".join(cmd))
print("CWD:", FRONTEND)
print("-" * 60)

proc = subprocess.run(
    cmd,
    cwd=FRONTEND,
    capture_output=True,
    text=True,
    shell=True,
)
print("STDOUT:\n", proc.stdout[-8000:])
print("STDERR:\n", proc.stderr[-8000:])
print("RETURNCODE:", proc.returncode)
sys.exit(proc.returncode)
