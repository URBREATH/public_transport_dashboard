import subprocess, sys
r = subprocess.run([sys.executable, "-m", "pip", "install", "jenkspy"],
                   capture_output=True, text=True)
print("RC", r.returncode)
print("OUT", r.stdout[-3000:])
print("ERR", r.stderr[-3000:])
