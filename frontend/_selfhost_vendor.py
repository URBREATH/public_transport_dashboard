# -*- coding: utf-8 -*-
"""
SELF-HOST delle risorse esterne della dashboard, per farla funzionare quando
pubblicata dietro una Content-Security-Policy 'self' (VM Azure labora.dedagroup.it).

Scarica/copia in src/assets/vendor/ :
  - leaflet.js            (copiato da node_modules)
  - leaflet.css           (copiato da node_modules)
  - georaster.browser.bundle.min.js         (CDN)
  - georaster-layer-for-leaflet.min.js      (CDN)
  - chart.umd.min.js                        (CDN)
  - inter.css + font .woff2                 (Google Fonts, CSS riscritto locale)
Cosi' index.html potra' referenziarle con path RELATIVI (assets/vendor/...),
rispettando script-src/style-src/font-src 'self'.
"""
import os, re, shutil, sys
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "src")
NODE = os.path.join(BASE, "node_modules")
VENDOR = os.path.join(SRC, "assets", "vendor")
FONTS = os.path.join(VENDOR, "fonts")

os.makedirs(VENDOR, exist_ok=True)
os.makedirs(FONTS, exist_ok=True)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

def fetch(url, dest_path, binary=True):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    mode = "wb" if binary else "w"
    if binary:
        with open(dest_path, "wb") as f:
            f.write(data)
    else:
        with open(dest_path, "w", encoding="utf-8") as f:
            f.write(data.decode("utf-8"))
    print(f"  OK  {os.path.relpath(dest_path, BASE)}  ({len(data)} bytes)  <- {url}")
    return data

def copy_node(rel_src, dest_name):
    s = os.path.join(NODE, rel_src)
    d = os.path.join(VENDOR, dest_name)
    if not os.path.exists(s):
        print(f"  ATTENZIONE: manca in node_modules {rel_src}")
        return False
    shutil.copy2(s, d)
    print(f"  OK  {os.path.relpath(d, BASE)}  (copiato da node_modules)")
    return True

print("== 1) Leaflet da node_modules ==")
copy_node(os.path.join("leaflet", "dist", "leaflet.js"), "leaflet.js")
copy_node(os.path.join("leaflet", "dist", "leaflet.css"), "leaflet.css")

print("== 2) JS da CDN ==")
fetch("https://unpkg.com/georaster@1.6.0/dist/georaster.browser.bundle.min.js",
      os.path.join(VENDOR, "georaster.browser.bundle.min.js"))
fetch("https://unpkg.com/georaster-layer-for-leaflet@3.10.0/dist/georaster-layer-for-leaflet.min.js",
      os.path.join(VENDOR, "georaster-layer-for-leaflet.min.js"))
fetch("https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
      os.path.join(VENDOR, "chart.umd.min.js"))

print("== 3) Font Inter (CSS + woff2) ==")
# Il CSS di Google contiene piu' @font-face con url(...woff2). Scarichiamo il CSS,
# poi tutti i woff2 referenziati, e riscriviamo gli url in locale (fonts/).
css_url = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
req = urllib.request.Request(css_url, headers={"User-Agent": UA})
with urllib.request.urlopen(req, timeout=60) as r:
    css = r.read().decode("utf-8")

font_urls = re.findall(r"url\((https://[^)]+\.woff2)\)", css)
font_urls = list(dict.fromkeys(font_urls))  # unici, mantiene ordine
print(f"  trovati {len(font_urls)} file woff2 da scaricare")

mapping = {}
for i, furl in enumerate(font_urls):
    fname = f"inter_{i}.woff2"
    fetch(furl, os.path.join(FONTS, fname))
    mapping[furl] = f"fonts/{fname}"

for furl, local in mapping.items():
    css = css.replace(furl, local)

with open(os.path.join(VENDOR, "inter.css"), "w", encoding="utf-8") as f:
    f.write(css)
print(f"  OK  assets/vendor/inter.css  (url riscritti in locale)")

print("\nFATTO. Contenuto assets/vendor/:")
for root, dirs, files in os.walk(VENDOR):
    for fn in files:
        p = os.path.join(root, fn)
        print("   ", os.path.relpath(p, VENDOR), os.path.getsize(p), "bytes")
