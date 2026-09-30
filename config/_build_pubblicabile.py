import os
import re
import shutil

# ---------------------------------------------------------------------------
# Script di "impacchettamento" della dashboard Angular gia' buildata in una
# struttura statica pubblicabile su una VM.
#
# PATCH-LUCA "pubblicabile-tutto-in-html-offline" (2026-08-04):
# STRUTTURA NUOVA: tutto racchiuso dentro html/ e completamente OFFLINE
# (niente CDN). Struttura generata:
#
#   pubblicabile/
#   └── html/
#       ├── index.html        (path riscritti ./css/ ./js/ ./data/)
#       ├── css/
#       │   ├── leaflet.css            (da file_standard/)
#       │   └── styles-<hash>.css      (dalla build + <style> inline prepended)
#       ├── js/
#       │   ├── chart.umd.min.js       (da file_standard/)
#       │   ├── polyfills-<hash>.js    (da file_standard/, rinominato con hash del main)
#       │   └── main-<hash>.js         (dalla build, con 'assets/' -> 'data/' riscritto)
#       ├── data/             (ex assets/: tutti i geojson/png/json)
#       └── media/
#
# NOTE IMPORTANTI:
# - I nomi con hash (main-XXXX.js, styles-XXXX.css) CAMBIANO ad ogni build:
#   lo script li rileva DINAMICAMENTE, non li fissa mai a un valore preciso.
# - assets/ viene rinominata 'data/' E ogni riferimento "assets/" dentro
#   main-*.js viene riscritto "data/" (altrimenti la dashboard non carica i dati).
# - Leaflet CSS, Chart.js e polyfills vengono presi da file_standard/ (versioni
#   locali) e NON piu' da CDN, cosi' la dashboard funziona anche offline.
# ---------------------------------------------------------------------------

# Gli script sono stati spostati in dashboard/config/: BASE deve puntare
# alla cartella padre (dashboard/), dove stanno frontend/, pubblicabile/, file_standard/.
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "frontend", "dist", "generic_dashbaord_frontend", "browser")
DEST = os.path.join(BASE, "pubblicabile")
STD = os.path.join(BASE, "file_standard")  # file "standard" locali (leaflet.css, chart.js, polyfills)

# Radice unica: tutto va dentro pubblicabile/html/
DIR_HTML = os.path.join(DEST, "html")
DIR_JS = os.path.join(DIR_HTML, "js")
DIR_CSS = os.path.join(DIR_HTML, "css")
DIR_DATA = os.path.join(DIR_HTML, "data")   # ex 'assets'
DIR_MEDIA = os.path.join(DIR_HTML, "media")

# file/cartelle da NON copiare (sorgenti/backup superflui in produzione)
SKIP_EXT = (".map",)
SKIP_NAMES = ("_stop_boards_backup",)
SKIP_SUFFIX = (".bak",)

# file "standard" locali attesi in file_standard/
STD_LEAFLET_CSS = "leaflet.css"
STD_CHART_JS = "chart.umd.min.js"
STD_POLYFILLS = "polyfills-FFHMD2TL.js"  # nome sorgente; verra' rinominato con hash del main

# PATCH-LUCA "self-host-vendor-in-pubblicabile" (2026-08-27): le librerie che
# in index.html erano referenziate come assets/vendor/*.js e assets/vendor/*.css
# NON venivano copiate ne' i loro path riscritti -> 404 in produzione. Le
# trattiamo come gli altri file_standard: JS -> js/, CSS (+ fonts) -> css/,
# e riscriviamo i riferimenti assets/vendor/ -> ./js/ e ./css/ nell'index.
STD_VENDOR_JS = (
    "leaflet.js",
    "georaster.browser.bundle.min.js",
    "georaster-layer-for-leaflet.min.js",
)
STD_VENDOR_CSS = ("inter.css",)
STD_FONTS_DIR = "fonts"  # in file_standard/fonts/ -> css/fonts/ (inter.css usa url(fonts/...))


def log(msg):
    print(msg)


def clean_dest():
    """Svuota da zero il CONTENUTO di pubblicabile/ (cosi' eventuali residui di
    vecchie strutture non restano mai), senza rimuovere la cartella radice stessa:
    su Windows la radice puo' essere 'in uso' (Explorer/editor/web server) e
    rmtree fallirebbe con WinError 32. Radice unica interna: pubblicabile/html/."""
    os.makedirs(DEST, exist_ok=True)
    for name in os.listdir(DEST):
        p = os.path.join(DEST, name)
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        except PermissionError:
            # file/cartella temporaneamente bloccato: si prosegue comunque
            log("  [WARN] impossibile rimuovere (in uso): %s" % name)
    for d in (DIR_HTML, DIR_JS, DIR_CSS, DIR_DATA, DIR_MEDIA):
        os.makedirs(d, exist_ok=True)


def is_skipped(name):
    if name in SKIP_NAMES:
        return True
    if name.endswith(SKIP_EXT):
        return True
    if name.endswith(SKIP_SUFFIX):
        return True
    return False


def copy_tree_filtered(src_dir, dst_dir):
    """Copia ricorsivamente src_dir in dst_dir saltando file/cartelle indesiderati."""
    n_files = 0
    n_bytes = 0
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if not is_skipped(d)]
        rel = os.path.relpath(root, src_dir)
        target_root = dst_dir if rel == "." else os.path.join(dst_dir, rel)
        os.makedirs(target_root, exist_ok=True)
        for f in files:
            if is_skipped(f):
                continue
            s = os.path.join(root, f)
            d = os.path.join(target_root, f)
            shutil.copy2(s, d)
            n_files += 1
            n_bytes += os.path.getsize(d)
    return n_files, n_bytes


def find_one(src_dir, prefix, suffix):
    """Trova l'UNICO file in src_dir che inizia con prefix e finisce con suffix
    (es. main- .js). Ritorna il nome file o None."""
    for f in os.listdir(src_dir):
        if f.startswith(prefix) and f.endswith(suffix) and not f.endswith(".map"):
            return f
    return None


def main():
    if not os.path.isdir(SRC):
        raise SystemExit("ERRORE: build sorgente non trovata in " + SRC)
    if not os.path.isdir(STD):
        raise SystemExit("ERRORE: cartella file_standard non trovata in " + STD)

    clean_dest()

    # ------------------------------------------------------------------
    # 1) Rileva DINAMICAMENTE i nomi con hash prodotti dalla build Angular.
    # ------------------------------------------------------------------
    main_js = find_one(SRC, "main-", ".js")
    if not main_js:
        raise SystemExit("ERRORE: main-*.js non trovato in " + SRC)
    styles_css = find_one(SRC, "styles-", ".css")
    if not styles_css:
        raise SystemExit("ERRORE: styles-*.css non trovato in " + SRC)

    # hash del main (es. da 'main-RNSE6LYM.js' -> 'RNSE6LYM')
    main_hash = main_js[len("main-"):-len(".js")]
    # il polyfills locale verra' rinominato con LO STESSO hash del main
    polyfills_out = "polyfills-%s.js" % main_hash

    log("  [DETECT] main   = %s (hash %s)" % (main_js, main_hash))
    log("  [DETECT] styles = %s" % styles_css)

    # ------------------------------------------------------------------
    # 2) JS -> html/js/
    #    - main-*.js  dalla build, con 'assets/' -> 'data/' riscritto
    #    - polyfills-<hash>.js  da file_standard/ (rinominato)
    #    - chart.umd.min.js     da file_standard/
    # ------------------------------------------------------------------
    with open(os.path.join(SRC, main_js), "r", encoding="utf-8") as fh:
        main_content = fh.read()
    # Riscrive i riferimenti ai dati: "assets/..." -> "data/..."
    n_repl = main_content.count("assets/")
    main_content = main_content.replace("assets/", "data/")
    with open(os.path.join(DIR_JS, main_js), "w", encoding="utf-8") as fh:
        fh.write(main_content)
    log("  [JS ] %s (assets/->data/ : %d occorrenze)" % (main_js, n_repl))

    # polyfills standard -> js/polyfills-<hash>.js
    std_poly = os.path.join(STD, STD_POLYFILLS)
    if not os.path.isfile(std_poly):
        raise SystemExit("ERRORE: %s non trovato in file_standard/" % STD_POLYFILLS)
    shutil.copy2(std_poly, os.path.join(DIR_JS, polyfills_out))
    log("  [JS ] %s (da file_standard/%s)" % (polyfills_out, STD_POLYFILLS))

    # chart.js standard -> js/chart.umd.min.js
    std_chart = os.path.join(STD, STD_CHART_JS)
    if not os.path.isfile(std_chart):
        raise SystemExit("ERRORE: %s non trovato in file_standard/" % STD_CHART_JS)
    shutil.copy2(std_chart, os.path.join(DIR_JS, STD_CHART_JS))
    log("  [JS ] %s (da file_standard/)" % STD_CHART_JS)

    # ------------------------------------------------------------------
    # 3) CSS -> html/css/
    #    - styles-<hash>.css dalla build, con <style> inline PREPENDED
    #    - leaflet.css       da file_standard/
    # ------------------------------------------------------------------
    # Lo <style> inline dell'index (html,body reset) va spostato DENTRO styles-*.css.
    inline_style = "html,body{margin:0;padding:0;height:100%;font-family:Segoe UI,Roboto,sans-serif}"
    with open(os.path.join(SRC, styles_css), "r", encoding="utf-8") as fh:
        styles_content = fh.read()
    styles_content = inline_style + "\n" + styles_content
    with open(os.path.join(DIR_CSS, styles_css), "w", encoding="utf-8") as fh:
        fh.write(styles_content)
    log("  [CSS] %s (+ <style> inline prepended)" % styles_css)

    # leaflet.css standard -> css/leaflet.css
    std_leaf = os.path.join(STD, STD_LEAFLET_CSS)
    if not os.path.isfile(std_leaf):
        raise SystemExit("ERRORE: %s non trovato in file_standard/" % STD_LEAFLET_CSS)
    shutil.copy2(std_leaf, os.path.join(DIR_CSS, STD_LEAFLET_CSS))
    log("  [CSS] %s (da file_standard/)" % STD_LEAFLET_CSS)

    # ------------------------------------------------------------------
    # 3-bis) VENDOR self-host (PATCH-LUCA "self-host-vendor-in-pubblicabile"):
    #    - leaflet.js, georaster*.js -> js/
    #    - inter.css -> css/  +  fonts/ -> css/fonts/
    # ------------------------------------------------------------------
    for js_name in STD_VENDOR_JS:
        std_js = os.path.join(STD, js_name)
        if not os.path.isfile(std_js):
            raise SystemExit("ERRORE: %s non trovato in file_standard/" % js_name)
        shutil.copy2(std_js, os.path.join(DIR_JS, js_name))
        log("  [JS ] %s (vendor da file_standard/)" % js_name)

    for css_name in STD_VENDOR_CSS:
        std_css = os.path.join(STD, css_name)
        if not os.path.isfile(std_css):
            raise SystemExit("ERRORE: %s non trovato in file_standard/" % css_name)
        shutil.copy2(std_css, os.path.join(DIR_CSS, css_name))
        log("  [CSS] %s (vendor da file_standard/)" % css_name)

    # fonts/ (usati da inter.css con url(fonts/inter_N.woff2)) -> css/fonts/
    std_fonts = os.path.join(STD, STD_FONTS_DIR)
    if os.path.isdir(std_fonts):
        nff, nfb = copy_tree_filtered(std_fonts, os.path.join(DIR_CSS, STD_FONTS_DIR))
        log("  [FONTS] %d file (%.1f KB) -> css/fonts/" % (nff, nfb / 1e3))
    else:
        log("  [WARN] cartella fonts/ non trovata in file_standard/ (inter.css senza glifi)")

    # ------------------------------------------------------------------
    # 4) assets/ -> html/data/
    # ------------------------------------------------------------------
    nf, nb = copy_tree_filtered(os.path.join(SRC, "assets"), DIR_DATA)
    log("  [DATA ] %d file (%.1f MB)  (ex assets/)" % (nf, nb / 1e6))

    # ------------------------------------------------------------------
    # 5) media/ -> html/media/
    # ------------------------------------------------------------------
    if os.path.isdir(os.path.join(SRC, "media")):
        nf2, nb2 = copy_tree_filtered(os.path.join(SRC, "media"), DIR_MEDIA)
        log("  [MEDIA ] %d file (%.1f KB)" % (nf2, nb2 / 1e3))

    # ------------------------------------------------------------------
    # 6) index.html -> html/index.html, con TUTTI i path riscritti.
    # ------------------------------------------------------------------
    with open(os.path.join(SRC, "index.html"), "r", encoding="utf-8") as fh:
        html = fh.read()

    # base href: "/" -> "./" (tutto relativo, l'index sta nella radice html/)
    html = html.replace('<base href="/">', '<base href="./">')

    # Leaflet CSS CDN -> locale ./css/leaflet.css
    html = re.sub(
        r'<link rel="stylesheet" href="https://unpkg\.com/leaflet@[^"]+/dist/leaflet\.css">',
        '<link rel="stylesheet" href="./css/leaflet.css">',
        html,
    )

    # Chart.js CDN -> locale ./js/chart.umd.min.js (con defer, come richiesto)
    html = re.sub(
        r'<script src="https://cdn\.jsdelivr\.net/npm/chart\.js@[^"]+/dist/chart\.umd\.min\.js"></script>',
        '<script defer src="./js/chart.umd.min.js"></script>',
        html,
    )

    # PATCH-LUCA "self-host-vendor-in-pubblicabile": riscrive i riferimenti alle
    # librerie self-hosted assets/vendor/* verso la struttura pubblicabile.
    #   assets/vendor/<x>.css -> ./css/<x>.css   (inter.css; leaflet.css lo copre gia' il blocco sopra ma qui e' generico)
    #   assets/vendor/<x>.js  -> ./js/<x>.js     (leaflet.js, georaster*, chart.umd.min.js)
    html = re.sub(
        r'(href|src)="assets/vendor/([^"]+\.css)"',
        r'\1="./css/\2"',
        html,
    )
    html = re.sub(
        r'(href|src)="assets/vendor/([^"]+\.js)"',
        r'\1="./js/\2"',
        html,
    )

    # <style> inline reset html,body: rimosso dall'index (spostato in styles-*.css)
    html = html.replace(
        "<style>html,body{margin:0;padding:0;height:100%;font-family:Segoe UI,Roboto,sans-serif}</style>",
        "",
    )

    # styles-<hash>.css: sia il link "media=print" sia il <noscript> -> ./css/...
    # e senza il trucco media=print (ora lo carichiamo direttamente).
    html = re.sub(
        r'<link rel="stylesheet" href="(styles-[^"]+\.css)" media="print" onload="this\.media=\'all\'">',
        r'<link rel="stylesheet" href="./css/\1">',
        html,
    )
    html = re.sub(
        r'<noscript><link rel="stylesheet" href="(styles-[^"]+\.css)"></noscript>',
        "",
        html,
    )

    # polyfills e main -> ./js/... (nomi con hash rilevati dinamicamente)
    html = re.sub(
        r'<script src="polyfills-[^"]+\.js" type="module"></script>',
        '<script src="./js/%s" type="module"></script>' % polyfills_out,
        html,
    )
    html = re.sub(
        r'<script src="(main-[^"]+\.js)" type="module"></script>',
        r'<script src="./js/\1" type="module"></script>',
        html,
    )

    with open(os.path.join(DIR_HTML, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    log("  [HTML] index.html (base ./, css/ js/ data/, offline no-CDN)")

    log("\nFATTO. Struttura creata in dashboard/pubblicabile/html/")


if __name__ == "__main__":
    main()
