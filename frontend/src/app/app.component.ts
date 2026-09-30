import { AfterViewInit, ChangeDetectorRef, Component, HostListener, NgZone, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import * as L from 'leaflet';

interface LayerCfg {
  id: string;
  label: string;
  file: string;
  // PATCH-LUCA "new-layers-coverage-deserts": aggiunti 2 nuovi kind dedicati:
  //   - 'coverage' : poligoni tematizzati su pct_covered (palette Purples, 5 fasce)
  //   - 'deserts'  : poligoni "transit desert" a colore unico (rosso trasparente)
  kind: 'polygons' | 'points' | 'lines' | 'coverage' | 'coverage_raster' | 'deserts' | 'deserts_raster' | 'population' | 'xyztiles';
  defaultOn?: boolean;
  hiddenInSidebar?: boolean;
  // PATCH-LUCA "ghsl-pop-tileserver": per il kind 'xyztiles' questo campo
  // contiene il template URL {z}/{x}/{y} del tile server esterno (es. GHSL
  // Copernicus). In tal caso NON si scarica alcun geojson/tiff: Leaflet chiede
  // le tile al server on-demand in base a zoom/pan (come una basemap overlay).
  tileUrl?: string;
  // PATCH-LUCA "layer-buttons-like-transport": icona del layer (stessa resa
  // grafica dei pulsanti categoria), iniettata come SafeHtml nel template.
  iconHtml?: SafeHtml;
}

interface CategoryCfg {
  id: string;
  label: string;
  prop: string;
  iconHtml: SafeHtml;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements AfterViewInit, OnDestroy {
  // === 3 SOLI LAYER richiesti ===
  // PATCH-LUCA "sidebar-english-accordion" + "no-default-category":
  // Il layer OSM (poligoni 15-minute) NON e' piu' attivo di default: all'avvio
  // l'utente vede la mappa "vuota" (solo basemap) e la sidebar senza alcuna
  // categoria selezionata. I poligoni vengono caricati solo quando l'utente
  // clicca una categoria (onSelectCategory). Nella sidebar compaiono solo i
  // 2 layer trasporto, con label in inglese, come toggle animati con
  // accordion di legenda.
  layers: LayerCfg[] = [
    {
      id: 'transport_15min',
      label: 'Leuven 15-min (Transport)',
      file: 'assets/transport_15min.geojson',
      kind: 'polygons',
      defaultOn: false,
      hiddenInSidebar: true,
    },
    {
      id: 'stops_clipped',
      label: 'Transport stop',
      file: 'assets/stop.geojson',
      kind: 'points',
      defaultOn: false,
    },
    {
      id: 'heatmap_lines_livery',
      label: 'Transport lines',
      file: 'assets/line.geojson',
      kind: 'lines',
      defaultOn: true,
    },
    // PATCH-LUCA "remove-freq-layers-2026-08-27" (richiesta Luca): i due layer
    // "Heatmap frequency" (heatmap_lines_freq, archi stradali) e
    // "Heatmap frequency 5x5" (heatmap_lines_grid5m, quadrati 5x5 m) sono stati
    // RIMOSSI dalla sidebar. Resta SOLO "Heatmap raster" (sotto), che eredita
    // l'icona a barre che prima era di "Heatmap frequency". Le funzioni di
    // toggle/click che referenziavano quegli id restano nel codice ma inerti,
    // perche' senza voce nell'array 'layers' non vengono mai renderizzate.
    // PATCH-LUCA "heatmap-raster-tif-layer" (richiesta Luca): unico layer
    // heatmap, chiamato "Heatmap raster".
    // Mostra il RASTER fornito dall'utente in data/raster_heatmap.tif, che la
    // pipeline (step 14_deploy_raster_heatmap_tif.py) converte in un PNG RGBA
    // tematizzato (palette bianco->rosso scuro, come le altre heatmap) +
    // bounds lat/lon, e deposita negli assets. In dashboard e' reso come
    // L.imageOverlay (imageOverlay Leaflet). A differenza dei due layer freq,
    // questo layer e' INDIPENDENTE: si accende/spegne da solo e puo' restare
    // acceso INSIEME agli altri (nessuna mutua esclusivita'). Il kind e'
    // 'lines' solo per riuso struttura: la logica di accensione dedicata (in
    // onToggleLayer) NON chiama loadLayer, usa addRasterHeatmapOverlay.
    {
      id: 'heatmap_raster',
      label: 'Heatmap frequency',
      file: '',
      kind: 'lines',
      defaultOn: false,
    },
    // 2 nuovi layer poligonali richiesti, aggiunti in fondo alla sidebar con
    // la stessa UX degli altri (pulsante che accende/spegne il layer + freccia
    // che apre/chiude la legenda a comparsa).
    //   - Population coverage: pct_covered (% di popolazione coperta dal
    //     trasporto entro 15 min), palette viola sequenziale (Purples) a 5
    //     fasce, colori presi 1:1 dal QML pop_coverage.qml.
    //   - Transit deserts: aree "deserto di trasporto" (pop = abitanti non
    //     serviti), simbolo unico rosso semitrasparente come nel QML
    //     transit_deserts.qml.
    {
      id: 'transit_deserts',
      label: 'Transit deserts',
      // PATCH-LUCA "transit-desert-as-tif-2026-09-08" (richiesta Luca): il layer
      // "Transit deserts" NON e' piu' un GeoJSON, ma un GeoTIFF a 3 BANDE
      // leggerissimo (assets/transit_desert.tif, ~27 KB) letto con georaster,
      // allineato pixel-perfect a pop_coverage_map.tif (stessa griglia). 3 bande:
      //   banda 1 = pop_uncovered -> COLORE (rosso semitrasparente, come QML)
      //   banda 2 = pop           -> abitanti (mostrato nel popup: "residents stranded")
      //   banda 3 = pct_covered   -> percentuale coperta
      // Al click leggo le 3 bande del pixel -> popup IDENTICO a quello del vecchio
      // geojson (stesso titolo "Transit desert", stesso numero di abitanti non
      // serviti). Nella pipeline lo step 99 deploya SOLO questo .tif negli assets.
      // Vedi addDesertsRaster / attachDesertsClick.
      file: 'assets/transit_desert.tif',
      kind: 'deserts_raster',
      defaultOn: false,
    },
    {
      id: 'pop_coverage_map',
      label: 'Population coverage',
      // PATCH-LUCA "coverage-raster-tif-2026-08-27" (richiesta Luca): il layer
      // Population coverage NON e' piu' un GeoJSON (~10 MB, lento), ma un
      // GeoTIFF a 4 BANDE leggerissimo (~107 KB) letto con georaster:
      //   banda 1 = pct_covered   -> COLORE (palette Purples, 5 fasce)
      //   banda 2 = pop_tot       -> residenti nella cella
      //   banda 3 = pop_covered   -> residenti coperti
      //   banda 4 = pop_uncovered -> residenti scoperti
      // Al click leggo tutte e 4 le bande del pixel -> popup con %, abitanti,
      // coperti e scoperti (vedi addCoverageRaster / attachCoverageClick).
      file: 'assets/pop_coverage_map.tif',
      kind: 'coverage_raster',
      defaultOn: false,
    },
    // PATCH-LUCA "remove-pop2025-geojson-2026-08-27" (richiesta Luca): il primo
    // layer "Population 2025" (population_2025, tasselli geojson locali) e' stato
    // RIMOSSO. Resta SOLO il secondo "Population 2025" (ghsl_pop_tiles), che usa
    // il TILE SERVER XYZ ufficiale GHSL Copernicus (nessun download di TIFF/geojson).
    {
      id: 'ghsl_pop_tiles',
      label: 'Population 2025',
      file: '',
      kind: 'xyztiles',
      tileUrl: 'https://human-settlement.emergency.copernicus.eu/d_prx.php/2023---GHS_POP_2025/{z}/{x}/{y}.png',
      defaultOn: false,
    },
  ];

  // Layer visibili nella sidebar (solo trasporto)
  get sidebarLayers(): LayerCfg[] {
    return this.layers.filter((l) => !l.hiddenInSidebar);
  }

  // PATCH-LUCA "sidebar-reorder-with-category-in-middle":
  // Ordine richiesto dei pulsanti sidebar:
  //   1) Transport stop            (stops_clipped)
  //   2) Transport lines           (heatmap_lines_livery)
  //   3) Transport stop accessability  (CATEGORIA "transport", blocco cat-grid)
  //   4) Heatmap frequency         (heatmap_lines_freq)
  //   5) Transit deserts           (transit_deserts)
  //   6) Population coverage        (pop_coverage_map)
  //   7) Population 2025            (population_2025)
  // Il blocco CATEGORIA e' un elemento HTML separato: per posizionarlo tra il
  // 2o e il 4o pulsante, la lista dei layer viene SPLITTATA in due getter:
  //   - sidebarLayersTop  = primi 2 layer (stops, lines) -> sopra la categoria
  //   - sidebarLayersRest = dal 3o in poi (freq, deserts, coverage, pop) -> sotto
  get sidebarLayersTop(): LayerCfg[] {
    return this.sidebarLayers.slice(0, 2);
  }
  get sidebarLayersRest(): LayerCfg[] {
    return this.sidebarLayers.slice(2);
  }

  // Stato UI: quali accordion legenda sono aperti (Set di id layer)
  // PATCH-LUCA "multi-open-legends": prima era una singola stringa (openLegend)
  // -> una sola legenda aperta per volta. Ora e' un Set, cosi' piu' legende
  // possono restare aperte CONTEMPORANEAMENTE (es. Transport stop + Transport
  // lines entrambe aperte).
  openLegends = new Set<string>();

  // Stato UI: quale layer e' attivo (mostrato in mappa)
  activeLayers = new Set<string>();

  categories: CategoryCfg[] = [];

  // === ICONE ===
  // - 'transport' = BUS (rettangolo con finestre + 2 ruote).
  // - 'entertainment', 'park', 'overall_average', 'education', 'health'
  //   sono copiate 1:1 da dashboard_embedded.html.
  // - 'marketgroc', 'postbank', 'restaurant', 'shop' non esistono nel file
  //   originale: le disegno io con lo stesso stile (24x24, stroke currentColor,
  //   stroke-width 1.5, linecap square, linejoin miter, fill none).
  private readonly ICONS_RAW: { [k: string]: string } = {
    transport: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <!-- corpo bus -->
      <rect x="3" y="4" width="18" height="12"/>
      <!-- finestre -->
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="4" x2="9" y2="9"/>
      <line x1="15" y1="4" x2="15" y2="9"/>
      <!-- porta al centro -->
      <line x1="12" y1="9" x2="12" y2="16"/>
      <!-- ruote -->
      <circle cx="7" cy="18" r="2"/>
      <circle cx="17" cy="18" r="2"/>
    </svg>`,
    entertainment: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <polygon points="5,3 19,12 5,21"/>
    </svg>`,
    // PATCH-LUCA "layer-buttons-like-transport": icone per i 3 layer trasporto,
    // stesso stile 24x24 delle icone categoria.
    // stops = fermata (pin/goccia con pallino)
    stops_clipped: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M12 2 C 8 2 5 5 5 9 C 5 14 12 22 12 22 C 12 22 19 14 19 9 C 19 5 16 2 12 2 Z"/>
      <circle cx="12" cy="9" r="2.5"/>
    </svg>`,
    // lines livery = linee/tracciati (percorso a zig-zag)
    heatmap_lines_livery: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M3 18 L9 6 L15 18 L21 6"/>
    </svg>`,
    // lines frequency = onde/frequenza (barre crescenti)
    heatmap_lines_freq: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <line x1="4" y1="20" x2="4" y2="14"/>
      <line x1="9" y1="20" x2="9" y2="10"/>
      <line x1="14" y1="20" x2="14" y2="6"/>
      <line x1="19" y1="20" x2="19" y2="3"/>
    </svg>`,
    // PATCH-LUCA "grid5m-second-freq-layer-2026-08-24": stessa icona a barre
    // del layer Heatmap frequency (il 2o pulsante e' identico al 1o).
    heatmap_lines_grid5m: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <line x1="4" y1="20" x2="4" y2="14"/>
      <line x1="9" y1="20" x2="9" y2="10"/>
      <line x1="14" y1="20" x2="14" y2="6"/>
      <line x1="19" y1="20" x2="19" y2="3"/>
    </svg>`,
    // PATCH-LUCA "heatmap-raster-icon-from-freq-2026-08-27" (richiesta Luca):
    // il layer "Heatmap raster" (ora unico layer heatmap) eredita l'ICONA a
    // barre crescenti che prima era del layer "Heatmap frequency".
    heatmap_raster: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <line x1="4" y1="20" x2="4" y2="14"/>
      <line x1="9" y1="20" x2="9" y2="10"/>
      <line x1="14" y1="20" x2="14" y2="6"/>
      <line x1="19" y1="20" x2="19" y2="3"/>
    </svg>`,
    // (stesso stile 24x24 delle altre icone della sidebar).
    // Population coverage = persone/copertura (gruppo di persone)
    pop_coverage_map: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <circle cx="9" cy="8" r="3"/>
      <path d="M3 20 C 3 15 6 14 9 14 C 12 14 15 15 15 20"/>
      <circle cx="17" cy="9" r="2"/>
      <path d="M16 14 C 19 14 21 15 21 19"/>
    </svg>`,
    // Transit deserts = area problematica (triangolo di allerta con "!")
    transit_deserts: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M12 3 L22 20 H2 Z"/>
      <line x1="12" y1="10" x2="12" y2="15"/>
      <line x1="12" y1="17" x2="12" y2="17.5"/>
    </svg>`,
    // PATCH-LUCA "population-2025-layer": icona per il layer Population 2025
    // (griglia di tasselli = raster di popolazione, stesso stile 24x24).
    population_2025: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <rect x="3" y="3" width="18" height="18"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
      <line x1="15" y1="3" x2="15" y2="21"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="3" y1="15" x2="21" y2="15"/>
    </svg>`,
    // PATCH-LUCA "ghsl-pop-tileserver": stessa icona a griglia del layer
    // Population 2025 (tile server GHSL). Identica graficamente.
    ghsl_pop_tiles: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <rect x="3" y="3" width="18" height="18"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
      <line x1="15" y1="3" x2="15" y2="21"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="3" y1="15" x2="21" y2="15"/>
    </svg>`,
    education: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M2 10L12 4l10 6-10 6L2 10z"/>
      <path d="M6 12v5c0 2 2.5 3 6 3s6-1 6-3v-5"/>
    </svg>`,
    health: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <rect x="3" y="3" width="18" height="18"/>
      <line x1="12" y1="7" x2="12" y2="17"/>
      <line x1="7" y1="12" x2="17" y2="12"/>
    </svg>`,
    marketgroc: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <!-- carrello della spesa: cestello + maniglia + 2 ruote -->
      <path d="M3 4 H6 L8 15 H19"/>
      <path d="M8 8 H21 L19 15"/>
      <circle cx="10" cy="19" r="1.5"/>
      <circle cx="17" cy="19" r="1.5"/>
    </svg>`,
    park: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M12 2 L5 12 H9 L4 19 H20 L15 12 H19 Z"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
    </svg>`,
    postbank: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <!-- edificio banca/posta: frontone + colonne + base -->
      <polygon points="12,3 22,8 2,8"/>
      <line x1="2" y1="8" x2="22" y2="8"/>
      <line x1="5" y1="10" x2="5" y2="18"/>
      <line x1="10" y1="10" x2="10" y2="18"/>
      <line x1="14" y1="10" x2="14" y2="18"/>
      <line x1="19" y1="10" x2="19" y2="18"/>
      <line x1="2" y1="20" x2="22" y2="20"/>
    </svg>`,
    restaurant: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <!-- forchetta -->
      <line x1="6" y1="2" x2="6" y2="22"/>
      <line x1="3" y1="2" x2="3" y2="9"/>
      <line x1="9" y1="2" x2="9" y2="9"/>
      <line x1="3" y1="9" x2="9" y2="9"/>
      <!-- coltello -->
      <path d="M17 2 C 19 2 20 6 20 10 L 17 10 Z"/>
      <line x1="17" y1="10" x2="17" y2="22"/>
    </svg>`,
    shop: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <!-- shopping bag: corpo + manici -->
      <path d="M4 8 H20 L19 21 H5 Z"/>
      <path d="M8 8 V6 C 8 4 10 3 12 3 C 14 3 16 4 16 6 V8"/>
    </svg>`,
    overall_average: `<svg class="cat-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <polygon points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9"/>
    </svg>`,
  };

  // PATCH-LUCA "no-default-category": all'avvio nessuna categoria e' selezionata.
  // La legenda "Walking time" resta nascosta e i poligoni non sono caricati
  // finche' l'utente non clicca una categoria.
  activeCategory: string = '';

  // PATCH-LUCA "transport-opacity-slider-2026-09-09" (richiesta Luca):
  // Sotto la legenda "Walking time (min)" della categoria Transport stop
  // accessibility c'e' una BARRA DI SCORRIMENTO ORIZZONTALE (slider) da 0 a 100%
  // con cui l'utente regola l'OPACITA' degli esagoni 15-min in mappa. Il valore
  // di DEFAULT e' quello ATTUALE (0.281 = 28.1%, ovvero la progressione storica
  // 0.18 -> 0.234 -> 0.281). Muovendo lo slider (onTransportOpacityChange) si
  // aggiorna in tempo reale lo stile del layer 'transport_15min' senza ricaricare
  // il geojson. styleForPolygon usa this.transportOpacity al posto del vecchio
  // valore fisso, cosi' fillOpacity e opacity seguono lo slider (sia per le celle
  // colorate sia per quelle grigie/senza valore). Il fallback di
  // animatePolygonsFadeIn usa lo stesso this.transportOpacity.
  /** Opacita' base (0..1) del layer Transport stop accessibility (esagoni 15-min).
   *  Default = 0.281 (valore attuale). Regolabile dallo slider in legenda. */
  transportOpacity = 0.281;

  /** Percentuale (0..100) mostrata accanto allo slider, derivata da transportOpacity. */
  get transportOpacityPct(): number {
    return Math.round(this.transportOpacity * 100);
  }

  /**
   * Handler dello slider opacita' del layer Transport (input range 0..100).
   * Converte il valore percentuale in 0..1, aggiorna transportOpacity e, se il
   * layer esagoni e' in mappa, ne ridipinge lo stile con la nuova opacita'
   * (setStyle -> styleForPolygon che ora legge this.transportOpacity).
   */
  onTransportOpacityChange(ev: Event): void {
    ev.stopPropagation();
    const raw = parseFloat((ev.target as HTMLInputElement).value);
    const pct = isNaN(raw) ? 28 : Math.max(0, Math.min(100, raw));
    this.transportOpacity = pct / 100;
    const layer = this.layerCache.get('transport_15min');
    if (layer) {
      layer.setStyle((f: any) => this.styleForPolygon(f));
    }
  }

  // PATCH-LUCA "city-name-data-driven" (richiesta Luca): nome della CITTA' dei
  // dati, letto a runtime dal campo "name" di assets/city_bounds.json (che la
  // pipeline, step 00, estrae dal confine comunale lau_eurostat.gpkg tramite il
  // centroide/attributo LAU_NAME). Cosi' i titoli della dashboard (h1 header,
  // titolo pannello Analytics, <title> della tab) mostrano AUTOMATICAMENTE la
  // citta' giusta (Madrid, Leuven, ...) ad ogni run della pipeline, senza
  // hardcoding. Fallback: '' finche' il JSON non e' caricato (i titoli mostrano
  // solo la parte fissa). Vedi setCityName() e fitToCityBounds().
  cityName: string = '';

  // === PATCH-LUCA "basemap-dropdown" ===
  // 4 basemap selezionabili dal pulsante tondo in alto a destra.
  // - "carto_light" = quella attuale di default (CARTO Light) -> tema pulsante CHIARO
  // - "carto_dark"  = versione scura della stessa (CARTO Dark) -> tema pulsante SCURO
  // - "osm"         = OSM standard classica -> tema pulsante CHIARO
  // - "esri_sat"    = Esri World Imagery (ortofoto satellitare) -> tema pulsante SCURO
  //
  // thumbUrl = singola tile 256x256 a zoom 14 centrata sul centro storico di
  // Leuven (Grote Markt, x=8405 y=5493): e' una vera tile del provider
  // selezionato, quindi l'anteprima mostra Leuven renderizzata esattamente
  // come apparira' scegliendo quella basemap.
  basemaps: {
    id: string;
    label: string;
    urlTemplate: string;
    options: L.TileLayerOptions;
    thumbUrl: string;
    dark: boolean;
  }[] = [
    {
      // PATCH-LUCA "carto-apikey-fix-2026-09-11": CARTO ha reso i suoi basemap
      // raster (basemaps.cartocdn.com) a pagamento/con API key: senza chiave
      // compare il watermark "API key required" ripetuto su tutte le tile.
      // Sostituito con Esri "Light Gray Canvas" (equivalente chiaro a Positron),
      // gratuito e SENZA API key. id 'carto_light' e label 'Carto Light'
      // MANTENUTI per non toccare il resto del codice (default, tema pulsante).
      id: 'carto_light',
      label: 'Esri Light Gray',
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 16, attribution: 'Tiles © Esri' },
      thumbUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/14/5493/8405',
      dark: false,
    },
    {
      // PATCH-LUCA "carto-apikey-fix-2026-09-11": vedi sopra. Sostituito con
      // Esri "Dark Gray Canvas" (equivalente scuro a Dark Matter), gratuito e
      // SENZA API key. id 'carto_dark' e label 'Carto Dark' MANTENUTI.
      id: 'carto_dark',
      label: 'Esri Dark Gray',
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 16, attribution: 'Tiles © Esri' },
      thumbUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/14/5493/8405',
      dark: true,
    },
    {
      id: 'osm',
      label: 'OSM Standard',
      urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, subdomains: 'abc', attribution: '© OpenStreetMap contributors' },
      thumbUrl: 'https://a.tile.openstreetmap.org/14/8405/5493.png',
      dark: false,
    },
    {
      id: 'esri_sat',
      label: 'Esri World Imagery',
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles © Esri' },
      thumbUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5493/8405',
      dark: true,
    },
  ];

  /** Basemap attualmente selezionata.
   * PATCH-LUCA "default-esri-basemap": all'avvio la dashboard mostra la mappa
   * ESRI World Imagery (ortofoto satellitare) come default, invece di
   * carto_light. La applyBasemap(this.activeBasemapId) in ngAfterViewInit usa
   * questo valore iniziale, quindi cambiarlo qui e' sufficiente. */
  activeBasemapId: string = 'esri_sat';

  /** Dropdown aperto/chiuso. */
  basemapMenuOpen: boolean = false;

  /** True se la basemap attiva e' scura -> usa .basemap-btn--dark per il pulsante tondo. */
  get isDarkBasemap(): boolean {
    return !!this.basemaps.find(b => b.id === this.activeBasemapId)?.dark;
  }

  /** Layer Leaflet della basemap attualmente sulla mappa (per poterlo rimuovere al cambio). */
  private basemapLayer?: L.TileLayer;

  // PATCH-LUCA "ghsl-pop-tileserver": layer XYZ esterni (tile server) accesi,
  // indicizzati per id layer. Es. il layer GHSL Population (tile server
  // Copernicus) che NON scarica dati ma li richiede on-demand al server.
  private xyzTileLayers = new Map<string, L.TileLayer>();

  private map!: L.Map;
  private layerCache = new Map<string, L.GeoJSON>();

  // PATCH-LUCA "polygons-canvas-renderer-2026-08-06" (richiesta Luca):
  // Il layer "Transport stop accessability" (poligoni 15-min) su citta' grandi
  // come Madrid ha 178k celle: renderizzate come SVG (default Leaflet) generano
  // 178k <path> nel DOM -> il browser diventa lentissimo a caricare e a fare
  // pan/zoom. Con un renderer CANVAS dedicato (come gia' fatto per le ~460k
  // celle della heatmap frequency) i poligoni vengono disegnati su un unico
  // <canvas>: il layer appare IDENTICO (stessi colori, stesso click/popup) ma
  // la mappa resta fluida e il caricamento e' molto piu' rapido. padding 0.5
  // per pre-disegnare un po' oltre il bordo viewport ed evitare "tagli" in pan.
  private polygonsRenderer: L.Canvas = L.canvas({ padding: 0.5 });

  // ============================================================
  // PATCH-LUCA "transport-cells-ondemand-tiles-2026-08-06" (richiesta Luca):
  // Gli esagoni "Transport stop accessability" (transport_stop = minuti a piedi)
  // NON vengono piu' caricati tutti insieme (178.114 poligoni su Madrid =
  // caricamento lento). Sono stati pre-spezzati OFFLINE (split_transport_tiles.py)
  // in 541 TESSERE geografiche (assets/transport_tiles/<ix>_<iy>.geojson, media
  // ~329 esagoni l'una) + un index.json. In runtime carico ON-DEMAND SOLO le
  // tessere che ricadono nel VIEWPORT corrente, aggiornandole ad ogni pan/zoom.
  // Stesso identico meccanismo gia' usato per le celle heatmap frequency
  // (freq_cells_tiles), qui applicato agli esagoni.
  //
  // Stato:
  //   polyTilesIndex   = contenuto di transport_tiles/index.json (tile_deg, tiles)
  //   polyTilesGroup   = L.LayerGroup che contiene i sotto-layer per tessera
  //   polyTilesLoaded  = Map tileKey -> L.GeoJSON gia' in mappa (per non ricaricare)
  //   polyTilesActive  = true se la categoria e' accesa (per evitare fetch inutili)
  //   _polyMoveHandler = handler moveend/zoomend agganciato alla mappa
  // Sotto POLY_TILES_MIN_ZOOM (11) la vista e' troppo ampia (tutto il comune):
  // non carico le tessere. Sopra tale zoom le celle appaiono sempre (anche su
  // viste d'insieme di quartiere). Il CLICK con le info si abilita invece solo
  // da POLY_CLICK_MIN_ZOOM (15) in su, per tenere leggera l'interazione.
  // ============================================================
  private readonly POLY_TILES_INDEX_JSON = 'assets/transport_tiles/index.json';
  private readonly POLY_TILES_DIR = 'assets/transport_tiles/';
  // PATCH-LUCA "transport-cells-show-always-click-on-zoom-2026-08-24" (richiesta Luca):
  // Il layer "Transport stop accessability" deve APPARIRE SEMPRE (a tutti gli zoom),
  // non solo zoomando: quindi la soglia di CARICAMENTO tessere torna bassa (11) cosi'
  // le celle si vedono anche sulle viste d'insieme. Per NON appesantire la mappa, il
  // CLICK che mostra le info (popup intensita') viene invece abilitato SOLO A ZOOM
  // INOLTRATO tramite la soglia separata POLY_CLICK_MIN_ZOOM (15). Sotto quel zoom il
  // popup non si apre (vedi bindPopup): si vede il layer ma non si interroga.
  private readonly POLY_TILES_MIN_ZOOM = 11; // sotto questo zoom non carico le tessere (vista troppo ampia = tutto il comune)
  private readonly POLY_CLICK_MIN_ZOOM = 15; // il popup info sugli esagoni si apre SOLO da questo zoom in su (per alleggerire)
  private polyTilesIndex: { tile_deg: number; tiles: { [k: string]: string } } | null = null;
  private polyTilesGroup: L.LayerGroup | null = null;
  private polyTilesLoaded = new Map<string, L.GeoJSON>();
  private polyTilesActive = false;
  private _polyMoveHandler: (() => void) | null = null;

  // PATCH-LUCA "map-trackpad-pinch-block-2026-08-05": riferimenti al listener
  // 'wheel' non-passivo che blocca lo zoom-pagina del browser sul pinch trackpad
  // (ctrlKey). Salvati per poterli rimuovere in ngOnDestroy.
  private _blockCtrlWheel?: (e: WheelEvent) => void;
  private _blockCtrlWheelEl?: HTMLElement;
  private _blockCtrlWheelEl2?: HTMLElement;

  // PATCH-LUCA "preload-polygons-no-lag":
  // Cache del GeoJSON GREZZO dei poligoni Transport, precaricato in background
  // in ngAfterViewInit. Cosi' al PRIMO click su Transport i dati sono gia'
  // pronti (niente fetch da 1.5MB durante il click) e l'animazione di
  // comparsa puo' partire ISTANTANEAMENTE, senza lo scatto/lag iniziale.
  private polygonsGeojsonCache: any = null;
  private polygonsPreloading = false;

  // PATCH-LUCA "keep-view-on-toggle": flag alzato al primo fitBounds,
  // dopo di che i toggle successivi NON riposizionano piu' la mappa.
  // PATCH-LUCA "no-initial-zoom-out": variabile didInitialFit rimossa.
  // La view iniziale e' fissata in ngAfterViewInit e non deve mai essere
  // sovrascritta automaticamente dai layer.

  // Legenda colori 15-min (identica a dashboard_embedded)
  private readonly COLOR_STOPS_15: [number, string][] = [
    [0, '#22c55e'],
    [15, '#22c55e'],
    [15.0001, '#fde047'],
    [30, '#ca8a04'],
    [30.0001, '#f87171'],
    [60, '#7f1d1d'],
  ];

  // PATCH-LUCA "stops-5-tiers":
  // 5 categorie di fermate per lines_count (quantili sui 373 stops reali).
  // Ordinato dalla meno usata alla piu' usata. Le proprieta' name/desc sono
  // in inglese perche' compaiono direttamente nella legenda della sidebar.
  // La palette e' una scala viola sequenziale (Deda) leggibile su CARTO light:
  // le fermate piu' importanti sono piu' scure e piu' grandi.
  // PATCH-LUCA "dynamic-legends-2026-09-02" (richiesta Luca): reso MUTABILE
  // (era readonly). Le soglie/etichette di "number of lines" vengono
  // RICALCOLATE a runtime (quintili sui lines_count reali) in
  // recomputeDynamicTiers(). I valori qui sotto restano solo come fallback.
  STOP_TIERS: {
    key: string;
    name: string;
    desc: string;
    range: [number, number]; // [min, max] inclusi
    radius: number;
    legendRadius: number;    // PATCH-LUCA "legend-slightly-bigger": raggio usato SOLO nella legenda sidebar
    color: string;
  }[] = [
    // PATCH-LUCA "stops-smaller-tighter": raggi mappa ridotti drasticamente e ravvicinati
    // (prima 3->13, ora 2->5): pallini molto piu' piccoli in mappa e con poca
    // differenza di size tra tier. Colori invariati.
    // PATCH-LUCA "legend-slightly-bigger": in legenda i dot vanno leggermente
    // piu' grandi (5->9) per essere leggibili nella sidebar, mentre in mappa
    // restano piccoli come voluto dall'utente.
    // PATCH-LUCA "stops-tiers-rebalance":
    //   - Occasional (1 line): era troppo chiaro/piccolo -> ora piu' scuro
    //     (#e9d5f0 -> #d0a8dc) e piu' grande (radius 2 -> 3, legendRadius 5 -> 7).
    //   - Major hub (8+ lines): era troppo scuro/grande -> ora meno scuro
    //     (#3d0055 -> #5b1179) e piu' piccolo (radius 5 -> 4).
    //   - I 3 tier intermedi sono stati riallineati per mantenere una scala
    //     comunque sequenziale ma con estremi meno estremi.
    // PATCH-LUCA "4-tiers-big-2026-09-02" (richiesta Luca): 4 FASCE (non 5).
    // L'ultima ("Major hub") rappresenta i "veri big": la sua soglia d'ingresso
    // e' calcolata a runtime col quantile q90 sui lines_count reali (vedi
    // applyLinesQuintiles). Le prime 3 usano i terzili della parte restante.
    // I valori qui sotto sono solo il FALLBACK iniziale.
    // PATCH-LUCA "4-tiers-colors-radii-2026-09-02" (richiesta Luca): 4 colori
    // ben SPALMATI e DISTINGUIBILI (chiaro -> molto scuro) e raggi mappa piu'
    // DIFFERENZIATI (2.5 -> 6), cosi' la fermata con piu' linee (Major hub)
    // risulta nettamente PIU' GRANDE e PIU' SCURA in mappa. Stessa palette/raggi
    // usati dalle altre 2 tematizzazioni (STAT_PALETTE/STAT_RADII) per coerenza.
    // PATCH-LUCA "lines-medium-more-contrast-2026-09-02" (richiesta Luca): con
    // Low #dcc2e8 (viola chiarissimo) e Medium #b06fd0 (viola medio) le prime
    // due fasce erano troppo simili. Ora Medium usa un viola PIU' SATURO/SCURO
    // (#7d1fa8) per staccare NETTAMENTE da Low, restando comunque piu' chiaro di
    // Very high (#3d0a5c). Scala: chiarissimo -> viola pieno -> quasi-nero.
    // PATCH-LUCA "jenks-4tiers-2026-09-04" (richiesta Luca): "number of lines"
    // ora ha 4 FASCE (Low/Medium/High/Very high) con soglie NATURAL BREAKS (Jenks)
    // di QGIS, calcolate a runtime in applyLinesJenks() e ARROTONDATE PER ECCESSO
    // (interi, senza decimali). I valori qui sotto sono solo il FALLBACK iniziale.
    // Colori e raggi presi dalla palette a 4 elementi STAT_PALETTE/STAT_RADII.
    { key: 'occasional', name: 'Low',       desc: '1-2 lines',  range: [1, 2],    radius: 3,    legendRadius: 7,    color: '#dcc2e8' },
    { key: 'standard',   name: 'Medium',    desc: '3-4 lines',  range: [3, 4],    radius: 3.25, legendRadius: 7.5,  color: '#b06fd0' },
    { key: 'high',       name: 'High',      desc: '5-7 lines',  range: [5, 7],    radius: 3.5,  legendRadius: 8,    color: '#7d1fa8' },
    { key: 'major',      name: 'Very high', desc: '8+ lines',   range: [8, 9999], radius: 3.75, legendRadius: 8.5,  color: '#3d0a5c' },
  ];

  /** Ritorna il tier di una fermata dato il suo lines_count. */
  stopTier(linesCount: any): { radius: number; color: string; name: string; desc: string } {
    const n = typeof linesCount === 'number' ? linesCount : parseInt(linesCount, 10);
    const val = isNaN(n) ? 0 : n;
    for (const t of this.STOP_TIERS) {
      if (val >= t.range[0] && val <= t.range[1]) return t;
    }
    return this.STOP_TIERS[0]; // fallback
  }

  // ============================================================
  // PATCH-LUCA "stops-thematize":
  // Le fermate (Transport stop) hanno ora piu' MODALITA' di tematizzazione,
  // selezionabili tramite il toggle "Thematize" nella legenda.
  //   - 'uniform' (DEFAULT): tutte le fermate viola, TUTTE DELLA STESSA
  //     dimensione (grandi). Nessuna informazione tematica.
  //   - 'lines'  : per numero di linee (i 5 tier STOP_TIERS, comportamento
  //                storico ora spostato dietro il toggle).
  //   - 'role'   : per ruolo della fermata (capolinea vs passaggio), campo
  //                geojson 'is_terminal' ('yes' | '').
  //   - 'service': per tipo di servizio, dedotto dal campo 'routes':
  //                Urban only / Mixed urban+regional-night / Regional-night
  //                only, dove le serie 4xx/5xx/6xx sono notturne/regionali.
  //
  // stopThemeMode  = modalita' attiva.
  // stopThematizeOpen = se il pannello con le 3 opzioni (checkbox) e' aperto.
  // ============================================================
  // PATCH-LUCA "walking-reach-buffer-2026-10-09" (richiesta Luca): aggiunta la
  // modalita' di tematizzazione 'reach' (walking reach 400m): in questa modalita'
  // le fermate NON sono piu' puntini ma BUFFER circolari di 400 m reali (tutte,
  // nessuna esclusa), riempimento viola chiaro e bordo viola sottile.
  stopThemeMode: 'uniform' | 'lines' | 'role' | 'service' | 'trip' | 'daily' | 'hourly' | 'shapes' | 'mode' | 'reach' = 'uniform';

  // ============================================================
  // PATCH-LUCA "stops-multimode" (2026-09-01, richiesta Luca):
  // PATCH-LUCA "stops-unified-single-file-2026-09-02" (richiesta Luca):
  // Il layer "Transport stop" carica le fermate da UN SOLO file UNIFICATO:
  //   assets/stop.geojson   (generato dallo step 02 della pipeline)
  // dove OGNI feature porta gia' la property 'mode' (bus/metro/tram) e, per le
  // fermate condivise tra piu' modi, 'sharedModes' = ['bus','tram'] (pallino
  // BICOLORE). I VECCHI 3 file separati stop_bus/metro/tram.geojson NON sono
  // piu' usati (ne' generati): erano ridondanti perche' l'informazione di modo
  // e' gia' dentro stop.geojson. Colori per modo: bus viola #7a1fa2, metro
  // azzurro #2e86de, tram fucsia #e91e8c.
  // Al fetch teniamo SOLO le fermate "vere" (location_type in ''/'0'),
  // scartando accessi/ascensori (location_type '2') e stazioni-contenitore ('1').
  // Le fermate con piu' modi (properties.sharedModes) sono rese con pallino
  // BICOLORE.
  //   - stopModeFilter  = insieme dei modi attualmente ACCESI (checkbox
  //                       Bus/Metro/Tram sopra "Thematize"). Una fermata e'
  //                       visibile finche' almeno uno dei suoi modi e' acceso.
  //   - availableStopModes = modi effettivamente presenti nella citta' (solo
  //                       questi mostrano il relativo checkbox).
  // La tematizzazione 'mode' ("service type") colora per modo di trasporto.
  // ============================================================
  private readonly STOP_MODE_ORDER: ('bus' | 'metro' | 'tram')[] = ['bus', 'metro', 'tram'];
  readonly STOP_MODE_TIERS: { key: 'bus' | 'metro' | 'tram'; name: string; color: string; radius: number; legendRadius: number }[] = [
    { key: 'bus',   name: 'Bus',   color: '#7a1fa2', radius: 5, legendRadius: 8 },
    { key: 'metro', name: 'Metro', color: '#2e86de', radius: 5, legendRadius: 8 },
    { key: 'tram',  name: 'Tram',  color: '#e91e8c', radius: 5, legendRadius: 8 },
  ];
  // PATCH-LUCA "stops-multimode": (STOP_MODE_ORDER e' gia' dichiarato sopra a
  // riga ~578; qui era duplicato -> rimosso per evitare "Duplicate identifier").
  // modi accesi (default: tutti). Riempito con i modi realmente presenti dopo il fetch.
  stopModeFilter: Set<'bus' | 'metro' | 'tram'> = new Set(['bus', 'metro', 'tram']);
  // modi realmente presenti in citta' (calcolato dopo il fetch dei 3 file).
  availableStopModes: ('bus' | 'metro' | 'tram')[] = [];
  stopThematizeOpen = false;

  // Colore/raggio della modalita' UNIFORM: tutte le fermate uguali.
  // PATCH-LUCA "uniform-lighter-smaller-outline": su richiesta utente i pallini
  // "None" (uniform) sono resi:
  //   - leggermente PIU' PICCOLI  (radius 6 -> 5.25)
  //   - riempimento viola leggermente PIU' CHIARO  (#7a1fa2 -> #9b4fc0)
  //   - CONTORNO = il viola "attuale" (#7a1fa2), impostato esplicitamente
  //     tramite il campo 'stroke' (in restyleStops, per la sola modalita'
  //     uniform, il contorno usa STOP_UNIFORM.stroke invece del darkenHex).
  // legendRadius invariato (la legenda None non mostra dot dimensionati).
  readonly STOP_UNIFORM = { color: '#9b4fc0', stroke: '#7a1fa2', radius: 5.25, legendRadius: 9 };

  // PATCH-LUCA "walking-reach-buffer-2026-10-09" (richiesta Luca): parametri
  // della modalita' "walking reach (400m)". Le fermate diventano buffer di 400 m
  // reali (raggio in METRI, disegnato con L.circle cosi' scala con lo zoom).
  // Riempimento viola CHIARO (dentro) e bordo VIOLA SOTTILE.
  readonly REACH_RADIUS_M = 400;          // raggio del buffer in metri
  readonly REACH_FILL = '#d9b3ec';        // viola chiaro (riempimento interno)
  readonly REACH_STROKE = '#7a1fa2';      // viola (bordo)
  // LayerGroup dedicato che contiene i buffer 400 m; popolato solo in modalita'
  // 'reach' e svuotato/rimosso appena si cambia tematizzazione.
  private reachBuffersGroup: L.LayerGroup | null = null;


  // Elenco delle modalita' di tematizzazione mostrate nella lista checkbox.
  // 'uniform' NON compare come opzione tematica: e' lo stato di default a cui
  // si torna quando nessuna tematizzazione e' selezionata.
  readonly STOP_THEMES: { key: 'none' | 'trip' | 'daily' | 'hourly' | 'lines' | 'shapes' | 'role' | 'service' | 'mode' | 'reach'; label: string }[] = [
    { key: 'none',    label: 'none' },
    // PATCH-LUCA "stops-multimode": "service type" e' ora la PRIMA voce e
    // colora le fermate per modo di trasporto (bus/metro/tram).
    { key: 'mode',    label: 'service type' },
    // PATCH-LUCA "remove-total-trip-theme-2026-09-02" (richiesta Luca):
    // rimossa la tematizzazione "total trip" (key 'trip') dalla lista.
    { key: 'hourly',  label: 'avg frequency hourly' },
    { key: 'lines',   label: 'number of lines' },
    { key: 'role',    label: 'stop role' },
    // PATCH-LUCA "walking-reach-buffer-2026-10-09" (richiesta Luca): ultima voce.
    // In questa modalita' ogni fermata diventa un buffer di 400 m reali.
    { key: 'reach',   label: 'walking reach (400m)' },
  ];

  // PATCH-LUCA "mono-service-hide-service-type-2026-11-09" (richiesta Luca):
  // Per le citta' con UN SOLO servizio (es. Leuven = solo bus) la tematizzazione
  // "service type" (key 'mode') NON deve comparire tra le opzioni di Thematize
  // del layer Transport stop: con un unico modo colorerebbe tutte le fermate
  // dello stesso colore, quindi e' inutile. Questo getter e' l'elenco delle
  // tematizzazioni EFFETTIVAMENTE mostrate: identico a STOP_THEMES ma senza la
  // voce 'mode' quando availableStopModes ha 0 o 1 modo. Il template itera su
  // visibleStopThemes invece che su STOP_THEMES.
  get visibleStopThemes(): { key: 'none' | 'trip' | 'daily' | 'hourly' | 'lines' | 'shapes' | 'role' | 'service' | 'mode' | 'reach'; label: string }[] {
    if (this.availableStopModes.length > 1) return this.STOP_THEMES;
    return this.STOP_THEMES.filter((t) => t.key !== 'mode');
  }

  // ============================================================
  // PATCH-LUCA "stop-stats-thematize" (2026-07-27):
  // 4 NUOVE tematizzazioni delle fermate basate sui dati orari precomputati
  // (assets/stop_stats.json, generato da gen_stop_stats.py per la settimana 0):
  //   - trip   : Total trip     (somma corse settimana, tutti i tipi-giorno)
  //   - daily  : Avg freq daily  (media corse/giorno sui tipi-giorno presenti)
  //   - hourly : Avg freq hourly (media corse/ora sui tipi-giorno presenti)
  //   - shapes : number of shapes (linee+capolinea distinti alla fermata)
  //
  // stopStats mappa stop_id -> { total, daily, hourly, shapes }.
  // Caricato in ngAfterViewInit; se non ancora pronto, le fermate restano nel
  // colore/raggio della fascia piu' bassa (fallback graceful).
  //
  // SOGLIE (5 fasce ciascuna) scelte sui QUINTILI reali delle 347 fermate con
  // dati (vedi output gen_stop_stats.py), arrotondate a valori "puliti":
  //   total  q20/40/60/80 = 102/131/143/213  -> <=80 /81-120 /121-160 /161-250 />250
  //   daily  q20/40/60/80 = 34/45/48/71      -> <=25 /26-40  /41-55   /56-90   />90
  //   hourly q20/40/60/80 = 2.0/2.5/2.6/3.8  -> <=1.5/1.6-2.5/2.6-3.5 /3.6-5   />5
  //   shapes q20/40/60/80 = 1/2/3/5          -> 1   /2      /3-4     /5-7     />7
  // Palette viola sequenziale (Deda), 5 fasce chiaro->scuro, come STOP_TIERS.
  // ============================================================
  private stopStats: { [id: string]: { total: number; daily: number; hourly: number; shapes: number } } = {};
  private stopStatsLoaded = false;

  // PATCH-LUCA "stop-info-only-2026-01-09" (richiesta Luca): mappa COMPLETA
  // stop_id -> { name, mode, lines, shapes, freq_hourly, weekly_avg } letta da
  // assets/stop_info.json (step 08_gen_stop_info.py). E' la sorgente dei 4
  // numeri mostrati nel popup della fermata (lines / shapes / freq_hourly /
  // weekly_avg), che sostituisce i vecchi tabelloni orari.
  // PATCH-LUCA "stopinfo-stop-url-2026-10-09" (richiesta Luca): aggiunto il campo
  // opzionale stop_url (link della fermata, letto da stops.txt del feed GTFS,
  // campo stop_url), mostrato in fondo al pannello fermata sotto l'elenco linee.
  private stopInfo: { [id: string]: { name: string; mode: string; lines: number; shapes: number; freq_hourly: number; weekly_avg: number; stop_url?: string; line_list?: { line: string; color: string; shapes: string[]; url?: string }[] } } = {};

  // PATCH-LUCA "stop-info-panel-4numbers" (2026-09-02): al click su una fermata
  // NON si apre piu' il grande overlay tabelloni orari, ma un pannello leggero
  // con i 4 numeri letti da stopInfo (stop_info.json). stopInfoView tiene i
  // valori della fermata attualmente aperta (null = nessun dato disponibile).
  stopInfoView: { lines: number; shapes: number; freq_hourly: number; weekly_avg: number; stop_url?: string; line_list: { line: string; color: string; shapes: string[]; url?: string }[] } | null = null;

  // PATCH-LUCA "stop-freq-full-week-7days-RAW" (2026-07-27):
  // Statistiche di frequenza PER SETTIMANA calcolate OFFLINE dai DATI GREZZI
  // GTFS (gen_stop_week_stats.py) sui 7 giorni REALI di ciascuna settimana,
  // senza distinzione feriale/festivo:
  //   total  = corse totali che passano alla fermata su lun..dom
  //   daily  = total / 7   (sempre diviso 7)
  //   hourly = total / ore-di-servizio-settimanali
  // Struttura file: { weeks_count, stats: { "<wi>": { "<stop_id>": {total,daily,hourly} } } }
  // Il popup orari legge weekStats[weekIdx][stop_id] per la fermata aperta.
  private weekStats: { [wi: string]: { [id: string]: { total: number; daily: number; hourly: number } } } = {};
  private weekStatsLoaded = false;

  // PATCH-LUCA "4-tiers-colors-only-2026-09-02" (richiesta Luca): i COLORI a 4
  // fasce restano quelli spalmati (chiaro -> molto scuro), ma i RAGGI TORNANO
  // ai valori originali ravvicinati (il raggio NON doveva cambiare tra fasce).
  private readonly STAT_PALETTE = ['#dcc2e8', '#b06fd0', '#7d1fa8', '#3d0a5c'];
  private readonly STAT_RADII = [3, 3.25, 3.5, 3.75];
  private readonly STAT_LEGEND_RADII = [7, 7.5, 8, 8.5];

  // Definizione soglie + etichette per ognuna delle 4 metriche.
  // range = [min, max] inclusi; l'ultimo tier ha max molto alto.
  // PATCH-LUCA "dynamic-legends-2026-09-02" (richiesta Luca): reso MUTABILE
  // (era readonly) perche' le soglie/etichette di questa legenda vengono
  // RICALCOLATE a runtime (quintili) dai dati realmente caricati, vedi
  // recomputeDynamicTiers(). I valori qui sotto restano come FALLBACK iniziale.
  // PATCH-LUCA "4-tiers-big-2026-09-02" (richiesta Luca): queste tematizzazioni
  // hanno ora SOLO 4 FASCE (non piu' 5). L'ULTIMA fascia rappresenta i "veri
  // big": e' calcolata a runtime con una soglia ALTA (quantile q90) cosi' che
  // ci finiscano solo le fermate nettamente piu' importanti. Le prime 3 fasce
  // usano i terzili della parte restante. Vedi recomputeDynamicTiers().
  // I valori qui sotto sono solo il FALLBACK iniziale (4 fasce).
  STOP_TRIP_TIERS = this.buildStatTiers([
    { name: 'Low',       desc: '\u2264120 trips',    range: [0, 120] as [number, number] },
    { name: 'Medium',    desc: '121\u2013200',        range: [121, 200] as [number, number] },
    { name: 'High',      desc: '201\u2013350',        range: [201, 350] as [number, number] },
    { name: 'Very high', desc: '>350 trips',      range: [351, 999999] as [number, number] },
  ]);
  readonly STOP_DAILY_TIERS = this.buildStatTiers([
    { name: 'Very low',  desc: '\u226425/day',     range: [0, 25] as [number, number] },
    { name: 'Low',       desc: '26\u201340/day',    range: [25.0001, 40] as [number, number] },
    { name: 'Medium',    desc: '41\u201355/day',    range: [40.0001, 55] as [number, number] },
    { name: 'High',      desc: '56\u201390/day',    range: [55.0001, 90] as [number, number] },
    { name: 'Very high', desc: '>90/day',       range: [90.0001, 999999] as [number, number] },
  ]);
  // PATCH-LUCA "4-tiers-big-2026-09-02": 4 fasce, ultima = "veri big" (q90).
  STOP_HOURLY_TIERS = this.buildStatTiers([
    { name: 'Low',       desc: '\u22642/h',        range: [0, 2] as [number, number] },
    { name: 'Medium',    desc: '2.1\u20133.5/h',    range: [2.1, 3.5] as [number, number] },
    { name: 'High',      desc: '3.6\u20136/h',      range: [3.6, 6] as [number, number] },
    { name: 'Very high', desc: '>6/h',          range: [6.1, 999999] as [number, number] },
  ]);
  readonly STOP_SHAPES_TIERS = this.buildStatTiers([
    { name: 'Single',    desc: '1 shape',       range: [0, 1] as [number, number] },
    { name: 'Few',       desc: '2 shapes',      range: [2, 2] as [number, number] },
    { name: 'Some',      desc: '3\u20134 shapes',   range: [3, 4] as [number, number] },
    { name: 'Many',      desc: '5\u20137 shapes',   range: [5, 7] as [number, number] },
    { name: 'Very many', desc: '>7 shapes',     range: [8, 999999] as [number, number] },
  ]);

  /** Costruisce i tier con palette/raggi viola sequenziali condivisi.
   * PATCH-LUCA "4-tiers-colors-radii-2026-09-02": palette/raggi ora hanno 4
   * elementi. Se una definizione ha piu' fasce (es. daily/shapes a 5, non tra
   * le 3 tematizzazioni attive), l'indice eccedente ricade sull'ULTIMO colore/
   * raggio disponibile (clamp) invece di restituire undefined. */
  private buildStatTiers(defs: { name: string; desc: string; range: [number, number] }[]) {
    const lastC = this.STAT_PALETTE.length - 1;
    const lastR = this.STAT_RADII.length - 1;
    const lastL = this.STAT_LEGEND_RADII.length - 1;
    return defs.map((d, i) => ({
      name: d.name,
      desc: d.desc,
      range: d.range,
      color: this.STAT_PALETTE[Math.min(i, lastC)],
      radius: this.STAT_RADII[Math.min(i, lastR)],
      legendRadius: this.STAT_LEGEND_RADII[Math.min(i, lastL)],
    }));
  }

  /** Ritorna il tier (colore+raggio) per un valore numerico dato l'array di soglie. */
  private statTier(val: number, tiers: { range: [number, number]; color: string; radius: number }[]) {
    for (const t of tiers) {
      if (val >= t.range[0] && val <= t.range[1]) return t;
    }
    return tiers[0];
  }

  // ============================================================
  // PATCH-LUCA "dynamic-legends-2026-09-02" (richiesta Luca):
  // LEGENDE E TEMATIZZAZIONI DINAMICHE per le fermate "Transport stop".
  // Le 3 modalita' richieste -- total trip (trip), avg frequency hourly
  // (hourly) e number of lines (lines) -- NON usano piu' soglie fisse
  // hardcoded, ma soglie CALCOLATE A RUNTIME dai DATI realmente caricati,
  // cosi' cambiano automaticamente in base alla VARIABILITA' del dato (per
  // qualsiasi citta'/dataset). Metodo unico:
  //   recomputeDynamicTiers() calcola i QUINTILI (q20/40/60/80) di:
  //     - total  (stopStats[*].total)   -> aggiorna STOP_TRIP_TIERS
  //     - hourly (stopStats[*].hourly)  -> aggiorna STOP_HOURLY_TIERS
  //     - lines  (lines_count fermate)  -> aggiorna STOP_TIERS
  //   e riscrive IN-PLACE i range[] e le etichette desc[] delle 5 fasce.
  // Le legende nel template usano gia' activeStatTiers (trip/hourly) e
  // STOP_TIERS (lines) via *ngFor, quindi si aggiornano DA SOLE. Se una
  // fermata e' gia' colorata in una di queste modalita', ridipingo (restyleStops).
  // ============================================================

  /** True quando le soglie dinamiche sono gia' state calcolate almeno una volta. */
  private dynamicTiersComputed = false;

  /** Quantile (metodo lineare) di un array gia' ORDINATO crescente. q in [0..1]. */
  private quantileSorted(sortedAsc: number[], q: number): number {
    const n = sortedAsc.length;
    if (n === 0) return 0;
    if (n === 1) return sortedAsc[0];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedAsc[lo];
    const frac = pos - lo;
    return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
  }

  /** Arrotonda "pulito" un numero-soglia per le etichette (interi se >=10). */
  private prettyThreshold(v: number, decimals: number): number {
    if (decimals <= 0) return Math.round(v);
    const p = Math.pow(10, decimals);
    return Math.round(v * p) / p;
  }

  /**
   * PATCH-LUCA "jenks-4tiers-2026-09-04" (richiesta Luca): NATURAL BREAKS (Jenks)
   * come in QGIS. Ritorna i (numClasses-1) "break" INTERNI che dividono i valori
   * in numClasses classi minimizzando la varianza intra-classe (algoritmo di
   * Fisher-Jenks). Input: array di numeri (anche non ordinato). Output: array
   * ordinato crescente dei break interni (upper bound di ogni classe tranne
   * l'ultima). Se ci sono pochi valori o poche classi utili, ripiega su un
   * campionamento uniforme cosi' il chiamante ha sempre qualcosa di sensato.
   * NB: su dataset grandi campiono a MAX_JENKS_SAMPLE valori per non appesantire
   * il browser (la matrice DP e' O(n*k)); i break restano rappresentativi.
   */
  private jenksBreaks(values: number[], numClasses: number): number[] {
    const clean = values.filter((v) => typeof v === 'number' && isFinite(v));
    if (!clean.length || numClasses < 2) return [];
    let data = clean.slice().sort((a, b) => a - b);
    // Campionamento per performance su dataset grandi (DP O(n*k)).
    const MAX_JENKS_SAMPLE = 2000;
    if (data.length > MAX_JENKS_SAMPLE) {
      const sampled: number[] = [];
      const stepS = data.length / MAX_JENKS_SAMPLE;
      for (let i = 0; i < MAX_JENKS_SAMPLE; i++) sampled.push(data[Math.floor(i * stepS)]);
      sampled.push(data[data.length - 1]);
      data = sampled;
    }
    const n = data.length;
    const k = Math.min(numClasses, n);
    if (k < 2) return [];

    // Matrici DP (1-based) come nell'implementazione classica di Jenks.
    const mat1: number[][] = [];
    const mat2: number[][] = [];
    for (let i = 0; i <= n; i++) {
      mat1.push(new Array(k + 1).fill(0));
      mat2.push(new Array(k + 1).fill(0));
    }
    for (let j = 1; j <= k; j++) {
      mat1[1][j] = 1;
      mat2[1][j] = 0;
      for (let i = 2; i <= n; i++) mat2[i][j] = Infinity;
    }

    for (let l = 2; l <= n; l++) {
      let s1 = 0, s2 = 0, w = 0;
      let v = 0;
      for (let m = 1; m <= l; m++) {
        const i3 = l - m + 1;
        const val = data[i3 - 1];
        s2 += val * val;
        s1 += val;
        w += 1;
        v = s2 - (s1 * s1) / w;
        const i4 = i3 - 1;
        if (i4 !== 0) {
          for (let j = 2; j <= k; j++) {
            if (mat2[l][j] >= v + mat2[i4][j - 1]) {
              mat1[l][j] = i3;
              mat2[l][j] = v + mat2[i4][j - 1];
            }
          }
        }
      }
      mat1[l][1] = 1;
      mat2[l][1] = v;
    }

    // Ricostruzione dei break interni.
    const kclass = new Array(k + 1).fill(0);
    kclass[k] = data[n - 1];
    let countNum = k;
    let idx = n;
    while (countNum >= 2) {
      const id = mat1[idx][countNum] - 1;
      kclass[countNum - 1] = data[id];
      idx = mat1[idx][countNum] - 1;
      countNum--;
    }
    // kclass[1..k-1] = break interni (escludo kclass[k] = max e kclass[0]).
    const breaks: number[] = [];
    for (let i = 1; i <= k - 1; i++) breaks.push(kclass[i]);
    // Ordino e deduplico per robustezza.
    const uniq = Array.from(new Set(breaks)).sort((a, b) => a - b);
    return uniq;
  }

  /**
   * PATCH-LUCA "jenks-4tiers-2026-09-04" (richiesta Luca): applica ad un array
   * di 4 TIER (dinamici) le soglie NATURAL BREAKS (Jenks) di QGIS, ARROTONDATE
   * PER ECCESSO (Math.ceil) e SENZA DECIMALI (interi). Prima usava i quantili;
   * ora usa this.jenksBreaks(values, 4) che ritorna i 3 break interni.
   * Riscrive range[] (contigui) e desc[] (etichette): tutte le soglie sono
   * interi, es. hourly -> "<=3/h", "4-6/h", "7-12/h", ">=13/h". opts.decimals
   * e' ignorato (si arrotonda sempre a intero per eccesso); unitSuffix es. "/h".
   */
  private applyQuintileTiers(
    tiers: { name: string; desc: string; range: [number, number]; color: string; radius: number; legendRadius: number }[],
    values: number[],
    opts: { unitSuffix: string; decimals: number; intMode: boolean },
  ): void {
    if (!tiers || tiers.length !== 4) return;
    const vals = values.filter((v) => typeof v === 'number' && isFinite(v));
    if (vals.length < 4) return; // troppo pochi dati: tengo il fallback

    // Break "natural breaks" (Jenks) a 4 classi -> 3 break interni.
    const rawBreaks = this.jenksBreaks(vals, 4);
    // Arrotondo PER ECCESSO ogni break (interi, niente decimali).
    let b = rawBreaks.map((x) => Math.ceil(x));
    // Garantisco 3 soglie STRETTAMENTE crescenti (t1 < t2 < t3). Se Jenks ha
    // prodotto meno di 3 break distinti (dati poco variabili), completo con +1.
    while (b.length < 3) b.push((b.length ? b[b.length - 1] : 0) + 1);
    b = b.slice(0, 3);
    let [t1, t2, t3] = b;
    if (t2 <= t1) t2 = t1 + 1;
    if (t3 <= t2) t3 = t2 + 1;

    const u = opts.unitSuffix;
    // PATCH-LUCA "last-tier-min-max-2026-09-09" (richiesta Luca): l'ULTIMA fascia
    // NON e' piu' ">=t3+1" ma "t3+1 - maxReale" (min ultima soglia .. massimo reale
    // del dato), come per l'heatmap. maxReale = valore massimo osservato (arrotondato
    // per eccesso, interi). Se maxReale <= t3+1 (dato poco variabile) forzo maxReale = t3+1.
    let maxReal = Math.ceil(Math.max(...vals));
    if (maxReal < t3 + 1) maxReal = t3 + 1;
    // PATCH-LUCA "first-tier-min-max-2026-10-09" (richiesta Luca): la PRIMA fascia
    // NON e' piu' "<=t1" ma "minReale - t1" (minimo reale del dato .. prima soglia),
    // simmetrico all'ultima fascia. minReale = valore minimo osservato (arrotondato
    // per eccesso, interi). Se minReale >= t1 (dato poco variabile) forzo minReale = 0.
    let minReal = Math.ceil(Math.min(...vals));
    if (minReal >= t1) minReal = 0;
    // Fascia 1 (Low):        minReale .. t1
    tiers[0].range = [0, t1];
    tiers[0].desc = `${minReal}\u2013${t1}${u}`;
    // Fascia 2 (Medium):     (t1+1)..t2
    tiers[1].range = [t1 + 1, t2];
    tiers[1].desc = `${t1 + 1}\u2013${t2}${u}`;
    // Fascia 3 (High):       (t2+1)..t3
    tiers[2].range = [t2 + 1, t3];
    tiers[2].desc = `${t2 + 1}\u2013${t3}${u}`;
    // Fascia 4 (Very high):  (t3+1)..maxReale
    tiers[3].range = [t3 + 1, maxReal];
    tiers[3].desc = `${t3 + 1}\u2013${maxReal}${u}`;
  }

  /**
   * Ricalcola le soglie dinamiche (quintili) per trip / hourly / lines dai
   * dati realmente caricati e ridipinge le fermate se sono in una di quelle
   * modalita'. Chiamato quando arrivano stopStats (stop_info.json) e quando e'
   * disponibile il geojson delle fermate (per lines_count).
   */
  private recomputeDynamicTiers(): void {
    // --- total trip e avg frequency hourly: dai valori di stopStats ---
    const stats = this.stopStats || {};
    const totals: number[] = [];
    const hourlies: number[] = [];
    for (const id of Object.keys(stats)) {
      const s = stats[id];
      if (!s) continue;
      if (typeof s.total === 'number' && s.total > 0) totals.push(s.total);
      if (typeof s.hourly === 'number' && s.hourly > 0) hourlies.push(s.hourly);
    }
    if (totals.length >= 4) {
      this.applyQuintileTiers(this.STOP_TRIP_TIERS, totals, { unitSuffix: ' trips', decimals: 0, intMode: true });
    }
    if (hourlies.length >= 4) {
      this.applyQuintileTiers(this.STOP_HOURLY_TIERS, hourlies, { unitSuffix: '/h', decimals: 1, intMode: false });
    }

    // --- number of lines: dai lines_count del geojson fermate ---
    const linesCounts = this.collectStopLinesCounts();
    if (linesCounts.length >= 4) {
      this.applyLinesQuintiles(linesCounts);
    }

    this.dynamicTiersComputed = true;

    // Se sto gia' visualizzando una di queste tematizzazioni, ridipingo subito.
    if (['trip', 'hourly', 'lines'].indexOf(this.stopThemeMode) !== -1) {
      this.restyleStops();
      try { this.cdr.detectChanges(); } catch (e) {}
    }
  }

  /** Raccoglie i lines_count (interi) di tutte le fermate, da dataCache['stops']
   *  o, in fallback, dal layer 'stops_clipped' in cache. */
  private collectStopLinesCounts(): number[] {
    let feats: any[] = [];
    const gj = this.dataCache['stops'];
    if (gj && Array.isArray(gj.features)) {
      feats = gj.features;
    } else {
      const layer = this.layerCache.get('stops_clipped');
      if (layer) { const acc: any[] = []; layer.eachLayer((s: any) => { if (s.feature) acc.push(s.feature); }); feats = acc; }
    }
    const out: number[] = [];
    for (const f of feats) {
      const raw = f?.properties?.['lines_count'];
      const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
      if (!isNaN(n) && n > 0) out.push(n);
    }
    return out;
  }

  /**
   * PATCH-LUCA "4-tiers-big-2026-09-02" (richiesta Luca): soglie dinamiche per
   * "number of lines" a 4 FASCE. I lines_count sono INTERI e piccoli.
   *   - 4a fascia ("Major hub" = veri big) parte da q90 (interi);
   *   - prime 3 fasce = terzili della parte NON big (sotto q90).
   * Aggiorno range[] + desc[] ("1-2 lines", "N+ lines") di STOP_TIERS (4 fasce).
   */
  /**
   * PATCH-LUCA "jenks-4tiers-2026-09-04" (richiesta Luca): soglie dinamiche per
   * "number of lines" a 4 FASCE con NATURAL BREAKS (Jenks) di QGIS, ARROTONDATE
   * PER ECCESSO (Math.ceil) e senza decimali (i lines_count sono gia' interi).
   * Aggiorno range[] + desc[] (<=N / N-M / >=N lines) di STOP_TIERS (4 fasce).
   */
  private applyLinesQuintiles(counts: number[]): void {
    const tiers = this.STOP_TIERS;
    if (!tiers || tiers.length !== 4) return;

    // Break "natural breaks" (Jenks) a 4 classi -> 3 break interni, per eccesso.
    const rawBreaks = this.jenksBreaks(counts, 4);
    let b = rawBreaks.map((x) => Math.ceil(x));
    // Almeno 3 soglie STRETTAMENTE crescenti (dati poco variabili -> completo +1).
    while (b.length < 3) b.push((b.length ? b[b.length - 1] : 0) + 1);
    b = b.slice(0, 3);
    let [t1, t2, t3] = b;
    if (t1 < 1) t1 = 1;
    if (t2 <= t1) t2 = t1 + 1;
    if (t3 <= t2) t3 = t2 + 1;

    const rng = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}\u2013${hi}`);
    // PATCH-LUCA "last-tier-min-max-2026-09-09" (richiesta Luca): l'ULTIMA fascia
    // NON e' piu' ">=t3+1 lines" ma "t3+1 - maxReale lines" (min ultima soglia ..
    // massimo reale dei lines_count), come per l'heatmap.
    let maxReal = Math.ceil(Math.max(...counts));
    if (maxReal < t3 + 1) maxReal = t3 + 1;
    // Fascia 1 (Low):        1 .. t1
    tiers[0].range = [1, t1];         tiers[0].desc = `${rng(1, t1)} lines`;
    // Fascia 2 (Medium):     (t1+1) .. t2
    tiers[1].range = [t1 + 1, t2];    tiers[1].desc = `${rng(t1 + 1, t2)} lines`;
    // Fascia 3 (High):       (t2+1) .. t3
    tiers[2].range = [t2 + 1, t3];    tiers[2].desc = `${rng(t2 + 1, t3)} lines`;
    // Fascia 4 (Very high):  (t3+1) .. maxReale
    tiers[3].range = [t3 + 1, maxReal];  tiers[3].desc = `${rng(t3 + 1, maxReal)} lines`;
  }


  /** Legenda dinamica per la modalita' stat attiva (usata nel template). */
  get activeStatTiers() {
    switch (this.stopThemeMode) {
      case 'trip':   return this.STOP_TRIP_TIERS;
      case 'daily':  return this.STOP_DAILY_TIERS;
      case 'hourly': return this.STOP_HOURLY_TIERS;
      case 'shapes': return this.STOP_SHAPES_TIERS;
      default:       return [];
    }
  }
  get activeStatHint(): string {
    switch (this.stopThemeMode) {
      case 'trip':   return 'Color = total number of trips serving the stop (week)';
      case 'daily':  return 'Color = average trips per day at the stop';
      case 'hourly': return 'Color = average trips per hour at the stop';
      case 'shapes': return 'Color = number of distinct line-routes (shapes) at the stop';
      default:       return '';
    }
  }

  // Legenda per la tematizzazione 'role' (is_terminal).
  readonly STOP_ROLE_TIERS: { key: string; name: string; desc: string; color: string; legendRadius: number; radius: number }[] = [
    { key: 'terminal', name: 'Terminal stop',  desc: 'start / end of line', color: '#5b1179', radius: 6, legendRadius: 9 },
    { key: 'through',  name: 'Through stop',    desc: 'intermediate',        color: '#c39bd3', radius: 4, legendRadius: 8 },
  ];

  // Legenda per la tematizzazione 'service' (dedotta da 'routes').
  // PATCH-LUCA "service-night-pink": viola/azzurro/ROSA (niente verde/arancio/blu).
  //   Urban only        -> viola   #8e44ad
  //   Urban + regional  -> azzurro #3498db (chiaro, saturo)
  //   Regional / night  -> rosa    #e91e8c (magenta acceso, spicca su viola e azzurro)
  readonly STOP_SERVICE_TIERS: { key: string; name: string; desc: string; color: string; legendRadius: number; radius: number }[] = [
    { key: 'urban',    name: 'Urban only',        desc: 'city lines only',        color: '#8e44ad', radius: 5, legendRadius: 8 },
    { key: 'mixed',    name: 'Urban + regional',  desc: 'also night/regional',    color: '#3498db', radius: 5, legendRadius: 8 },
    { key: 'regional', name: 'Regional / night',  desc: 'night/regional only',    color: '#e91e8c', radius: 5, legendRadius: 8 },
  ];

  /** Handler del toggle "Thematize": apre/chiude la lista delle modalita'. */
  onToggleThematize(ev: Event): void {
    ev.stopPropagation();
    this.stopThematizeOpen = !this.stopThematizeOpen;
  }

  /**
   * Selezione (radio) di una modalita' di tematizzazione delle fermate.
   * PATCH-LUCA "no-thematize-toggle":
   *   - 'none' -> torna a 'uniform' (tutte le fermate viola uguali).
   *   - 'lines' | 'role' | 'service' -> applica la tematizzazione scelta.
   *   Comportamento RADIO: cliccare un'opzione la seleziona (niente
   *   toggle-back a uniform ri-cliccando; per togliere la tematizzazione
   *   si sceglie esplicitamente 'None').
   * PATCH-LUCA "auto-turn-on-stops": se scelgo una tematizzazione (diversa da
   *   'none') e il layer Transport stop e' SPENTO, lo accendo automaticamente
   *   (equivale a premere il suo pulsante), cosi' le fermate compaiono subito
   *   in mappa. Se scelgo 'None' il layer resta com'e' (non lo spengo).
   */
  onSelectStopTheme(mode: 'none' | 'trip' | 'daily' | 'hourly' | 'lines' | 'shapes' | 'role' | 'service' | 'mode' | 'reach', ev: Event): void {
    ev.stopPropagation();
    this.stopThemeMode = mode === 'none' ? 'uniform' : mode;

    // PATCH-LUCA "none-also-turns-on-stops": QUALSIASI opzione cliccata
    // (compresa "None") accende il layer Transport stop se e' spento
    // (equivale a premere il suo pulsante). Cliccando "None" a layer spento
    // il layer si accende e mostra le fermate in vista uniforme.
    if (!this.activeLayers.has('stops_clipped')) {
      const cfg = this.layers.find((x) => x.id === 'stops_clipped');
      if (cfg) {
        this.activeLayers.add('stops_clipped');
        this.loadLayer(cfg);
      }
    }

    this.restyleStops();
  }

  /**
   * True se l'opzione di tematizzazione passata e' quella attiva (radio).
   * PATCH-LUCA "no-theme-checked-when-layer-off": se il layer Transport stop
   * (stops_clipped) e' SPENTO, NESSUNA opzione risulta selezionata (nemmeno
   * "None"), coerentemente col fatto che il pulsante del layer e' spento.
   * Le opzioni si "attivano" (None diventa il default selezionato) solo quando
   * il layer e' acceso.
   */
  isStopTheme(mode: 'none' | 'trip' | 'daily' | 'hourly' | 'lines' | 'shapes' | 'role' | 'service' | 'mode' | 'reach'): boolean {
    if (!this.activeLayers.has('stops_clipped')) return false;
    if (mode === 'none') return this.stopThemeMode === 'uniform';
    return this.stopThemeMode === mode;
  }

  /** Classifica una fermata per la tematizzazione 'role'. */
  private stopRole(f: any): { color: string; radius: number } {
    const isTerm = String(f?.properties?.['is_terminal'] ?? '').trim().toLowerCase() === 'yes';
    return isTerm ? this.STOP_ROLE_TIERS[0] : this.STOP_ROLE_TIERS[1];
  }

  /** Classifica una fermata per la tematizzazione 'service' (routes 4xx/5xx/6xx). */
  private stopService(f: any): { color: string; radius: number } {
    const routes = String(f?.properties?.['routes'] ?? '')
      .split(',').map((r) => r.trim()).filter((r) => r.length > 0);
    const isNight = (r: string) => /^[456]\d\d/.test(r);
    const hasNight = routes.some(isNight);
    const hasUrban = routes.some((r) => !isNight(r));
    if (hasNight && hasUrban) return this.STOP_SERVICE_TIERS[1]; // mixed
    if (hasNight) return this.STOP_SERVICE_TIERS[2];             // regional/night only
    return this.STOP_SERVICE_TIERS[0];                          // urban only
  }

  /**
   * PATCH-LUCA "stops-multimode": colore/raggio per modo di trasporto.
   * Legge properties.mode (bus/metro/tram) impostato in fase di fetch.
   */
  private stopMode(f: any): { color: string; radius: number } {
    const m = String(f?.properties?.['mode'] ?? 'bus');
    const tier = this.STOP_MODE_TIERS.find((t) => t.key === m) ?? this.STOP_MODE_TIERS[0];
    return { color: tier.color, radius: tier.radius };
  }

  /** True se la fermata condivide le stesse coordinate con piu' modi (es. bus+tram). */
  private isSharedStop(f: any): boolean {
    const sm = f?.properties?.['sharedModes'];
    return Array.isArray(sm) && sm.length > 1;
  }

  /** Colore CSS per il modo indicato (usato dal pallino bicolore delle condivise). */
  private colorForMode(m: string): string {
    const tier = this.STOP_MODE_TIERS.find((t) => t.key === m);
    return tier ? tier.color : '#7a1fa2';
  }

  // PATCH-LUCA "service-type-dots-thematize": versione PUBBLICA usata dal template
  // per colorare i 3 pallini della sezione "Service type" con il colore ufficiale
  // del modo (STOP_MODE_TIERS) quando la tematizzazione attiva e' "service type".
  modeColor(m: string): string {
    return this.colorForMode(m);
  }

  /**
   * Ritorna colore+raggio di una fermata in base alla modalita' attiva.
   * 'uniform' -> tutte uguali, viola, grandi.
   */
  private stopVisual(f: any): { color: string; radius: number } {
    switch (this.stopThemeMode) {
      case 'lines': {
        const t = this.stopTier(f?.properties?.['lines_count']);
        return { color: t.color, radius: t.radius };
      }
      case 'role':    return this.stopRole(f);
      case 'service': return this.stopService(f);
      // PATCH-LUCA "stops-multimode": "service type" = colore per modo (bus/metro/tram).
      case 'mode':    return this.stopMode(f);
      // PATCH-LUCA "stop-stats-thematize": 4 modalita' basate su stop_stats.json.
      case 'trip':
      case 'daily':
      case 'hourly':
      case 'shapes': {
        const sid = String(f?.properties?.['stop_id'] ?? '');
        const s = this.stopStats[sid];
        const tiers =
          this.stopThemeMode === 'trip'   ? this.STOP_TRIP_TIERS   :
          this.stopThemeMode === 'daily'  ? this.STOP_DAILY_TIERS  :
          this.stopThemeMode === 'hourly' ? this.STOP_HOURLY_TIERS :
                                            this.STOP_SHAPES_TIERS;
        const val = !s ? 0 :
          this.stopThemeMode === 'trip'   ? s.total  :
          this.stopThemeMode === 'daily'  ? s.daily  :
          this.stopThemeMode === 'hourly' ? s.hourly :
                                            s.shapes;
        const t = this.statTier(val, tiers);
        return { color: t.color, radius: t.radius };
      }
      case 'uniform':
      default:        return { color: this.STOP_UNIFORM.color, radius: this.STOP_UNIFORM.radius };
    }
  }

  /** Riapplica lo stile alle fermate in mappa (dopo un cambio di tematizzazione). */
  private restyleStops(): void {
    const layer = this.layerCache.get('stops_clipped');
    if (!layer) return;

    // PATCH-LUCA "walking-reach-buffer-2026-10-09" (richiesta Luca):
    // In modalita' 'reach' le fermate NON sono piu' puntini: ogni marker viene
    // reso invisibile (opacity/fillOpacity 0, raggio 0) e al suo posto si
    // disegnano i BUFFER da 400 m gestiti da syncReachBuffers(). Uscendo dalla
    // modalita' i buffer vengono rimossi e i marker tornano visibili.
    const isReach = this.stopThemeMode === 'reach';

    layer.eachLayer((sub: any) => {
      if (isReach) {
        // Nascondo il puntino (senza distruggerlo): niente fill, niente bordo.
        if (typeof sub.setStyle === 'function') {
          sub.setStyle({ opacity: 0, fillOpacity: 0 });
        }
        if (typeof sub.setRadius === 'function') {
          sub.setRadius(0);
        }
        // I marker "bicolore" (divIcon delle fermate condivise) non hanno
        // setStyle/setRadius: li tolgo dalla mappa cosi' non restano visibili
        // sopra i buffer. applyStopModeFilter() li riaggiunge uscendo da 'reach'.
        if (typeof sub.setStyle !== 'function' && this.map.hasLayer(sub)) {
          this.map.removeLayer(sub);
        }
        return;
      }
      const v = this.stopVisual(sub.feature);
      if (typeof sub.setStyle === 'function') {
        // PATCH-LUCA "uniform-lighter-smaller-outline": nella modalita' uniform
        // il contorno e' il viola "attuale" (STOP_UNIFORM.stroke), mentre il
        // riempimento e' il viola piu' chiaro (STOP_UNIFORM.color). Nelle altre
        // modalita' il contorno resta una versione scurita del fillColor.
        const stroke = this.stopThemeMode === 'uniform'
          ? this.STOP_UNIFORM.stroke
          : this.darkenHex(v.color, 0.15);
        // Ripristino opacita' piene (potrebbero essere state azzerate da 'reach').
        sub.setStyle({ fillColor: v.color, color: stroke, opacity: 1, fillOpacity: 0.90 });
      }
      if (typeof sub.setRadius === 'function') {
        sub.setRadius(v.radius);
      }
    });

    // Costruisce o rimuove i buffer 400 m in base alla modalita' corrente.
    this.syncReachBuffers();

    // Uscendo da 'reach', i marker divIcon (fermate condivise) erano stati
    // rimossi dalla mappa: applyStopModeFilter() li riaggiunge (rispettando i
    // filtri modo). In 'reach' la stessa chiamata e' innocua.
    if (!isReach) {
      this.applyStopModeFilter();
    }
  }

  /**
   * PATCH-LUCA "walking-reach-buffer-2026-10-09" (richiesta Luca):
   * Sincronizza il layer dei BUFFER da 400 m ("walking reach").
   * - Se la modalita' attiva e' 'reach': (ri)crea un L.circle di 400 m reali per
   *   OGNI fermata del layer stops_clipped (tutte, nessuna esclusa), con
   *   riempimento viola chiaro (REACH_FILL) e bordo viola sottile (REACH_STROKE),
   *   nella stessa pane delle fermate. Il raggio in metri fa si' che il cerchio
   *   scali correttamente con lo zoom della mappa.
   * - Altrimenti: svuota e rimuove il layer group dei buffer.
   */
  private syncReachBuffers(): void {
    // In ogni caso parto svuotando/rimuovendo i buffer esistenti.
    if (this.reachBuffersGroup) {
      this.map.removeLayer(this.reachBuffersGroup);
      this.reachBuffersGroup.clearLayers();
      this.reachBuffersGroup = null;
    }

    if (this.stopThemeMode !== 'reach') return;

    const layer = this.layerCache.get('stops_clipped') as any;
    if (!layer) return;

    const group = L.layerGroup();
    layer.eachLayer((sub: any) => {
      // FIX-LUCA "reach-respect-mode-filter-2026-11-09" (richiesta Luca): anche
      // in modalita' "walking reach (400m)" i buffer da 400 m devono RISPETTARE
      // il filtro Bus/Metro/Tram (checkbox "Service type"), esattamente come i
      // pallini normali (applyStopModeFilter). Prima syncReachBuffers creava un
      // cerchio per OGNI fermata (nessuna esclusa), quindi cliccando su un modo
      // il filtro non aveva effetto visibile: si continuavano a vedere i cerchi
      // di TUTTE le fermate. Ora salto la fermata se NESSUNO dei suoi modi
      // (sharedModes o mode) e' tra quelli accesi in stopModeFilter.
      const f = sub?.feature;
      if (f) {
        const modes = this.stopModesOf(f);
        const visible = modes.length === 0
          ? true
          : modes.some((m) => this.stopModeFilter.has(m as any));
        if (!visible) return;
      }

      // Coordinate della fermata: preferisco getLatLng() (circleMarker/marker),
      // altrimenti ricavo dalla geometria del feature.
      let latlng: L.LatLng | null = null;
      if (typeof sub.getLatLng === 'function') {
        latlng = sub.getLatLng();
      } else {
        const c = sub?.feature?.geometry?.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
          latlng = L.latLng(Number(c[1]), Number(c[0]));
        }
      }
      if (!latlng) return;

      const circle = L.circle(latlng, {
        pane: 'stopsPane',
        radius: this.REACH_RADIUS_M,   // 400 m REALI
        color: this.REACH_STROKE,       // bordo viola
        weight: 1,                      // bordo sottile
        opacity: 0.9,
        fillColor: this.REACH_FILL,     // riempimento viola chiaro
        fillOpacity: 0.25,
      });
      group.addLayer(circle);
    });

    group.addTo(this.map);
    this.reachBuffersGroup = group;
  }


  // PATCH-LUCA "freq-legend-qml":
  // Legenda "frequenza" (heatmap YlOrRd) presa dal QML di QGIS
  // (data/heatmap_stile.qml). Colori estratti dai simboli 0..4 del renderer
  // graduatedSymbol basato sull'attributo 'frequency':
  //   Low (1-10)              -> #ffffb2
  //   Moderate (11-40)        -> #fecc5c
  //   High (41-80)            -> #fd8d3c
  //   Very High (81-150)      -> #f03b20
  //   Major corridor (>150)   -> #bd0026
  // Questa e' la vista DI DEFAULT quando l'utente accende "Transit lines".
  // Cliccando il toggle nella legenda si passa alla LINE_LEGEND (livrea De Lijn).
  readonly FREQ_LEGEND: { color: string; name: string; desc: string; range: [number, number] }[] = [
    { color: '#ffffb2', name: 'Low',            desc: '1-40',      range: [1,    40]   },
    { color: '#fecc5c', name: 'Moderate',       desc: '41-120',    range: [41,   120]  },
    { color: '#fd8d3c', name: 'High',           desc: '121-250',   range: [121,  250]  },
    { color: '#f03b20', name: 'Very High',      desc: '251-999',   range: [251,  999]  },
    { color: '#7a0018', name: 'Major corridor', desc: '>1000',     range: [1000, 999999]},
  ];

  // PATCH-LUCA "freq-heatmap-strade" (richiesta Luca): legenda della NUOVA
  // Heatmap frequency calcolata sugli ARCHI STRADALI. Le 5 classi e i colori
  // sono quelli tematizzati in QGIS (step 7, palette YlOrRd) e coincidono con
  // i campi classe/classe_label/colore del geojson heatmap_freq_strade.
  // Le etichette sono in CORSE/GIORNO (freq_giornaliera), coerenti con la
  // classificazione a quantili calcolata sugli archi. Il click su un arco
  // mostra invece la frequenza ORARIA nell'info-box.
  readonly FREQ_STRADE_LEGEND: { color: string; name: string; desc: string }[] = [
    { color: '#ffffb2', name: 'Very low',       desc: '≤ 1 trip/h'   },
    { color: '#fecc5c', name: 'Low',            desc: '1 – 4.6 trip/h'  },
    { color: '#fd8d3c', name: 'Medium',         desc: '4.6 – 6 trip/h'  },
    { color: '#f03b20', name: 'High',           desc: '6 – 8.8 trip/h'  },
    { color: '#bd0026', name: 'Major corridor', desc: '> 8.8 trip/h'  },
  ];

  // PATCH-LUCA "freq-raster-overlay" (richiesta Luca): il layer "Heatmap
  // frequency" mostra ora il RASTER PNG generato dalla pipeline
  // (script_heatmap_freq/10_genera_raster_heatmap.py), sovrapposto in mappa
  // come L.imageOverlay sui bounds salvati in assets/heatmap_freq_raster_bounds
  // .json. Palette bianco->rosso scuro (meno passaggi -> piu' passaggi).
  // La legenda in sidebar mostra il GRADIENTE con min e max ai due estremi.
  private freqRasterOverlay: L.ImageOverlay | null = null;
  private freqRasterBounds: L.LatLngBoundsExpression | null = null;
  private readonly FREQ_RASTER_PNG = 'assets/heatmap_freq_raster.png';
  private readonly FREQ_RASTER_BOUNDS_JSON = 'assets/heatmap_freq_raster_bounds.json';

  // PATCH-LUCA "freq-raster-cells-click" (richiesta Luca): oltre al PNG (non
  // cliccabile) carico il GeoJSON delle CELLE della heatmap frequenze
  // (assets/heatmap_freq_raster_celle.geojson, generato dallo step 10). Ogni
  // cella ha la property 'freq_giornaliera' = passaggi/giorno in quel punto.
  // Il layer e' reso INVISIBILE (fill/stroke opacity 0) ma INTERATTIVO, con
  // renderer CANVAS (regge le ~42k celle senza appesantire il DOM). Al click
  // su una cella si apre un popup coerente col resto della dashboard
  // (stessa card 'lz-popup' usata da bindPopup) con la frequenza in evidenza.
  private freqCellsLayer: L.GeoJSON | null = null;
  private freqCellsLoaded = false;
  private readonly FREQ_RASTER_CELLE_JSON = 'assets/heatmap_freq_raster_celle.geojson';
  // Renderer canvas dedicato: gestisce molte migliaia di poligoni cliccabili
  // in modo performante (niente 42k <path> nel DOM SVG).
  private freqCellsRenderer: L.Canvas = L.canvas({ padding: 0.5 });

  // ============================================================
  // PATCH-LUCA "freq-cells-ondemand-tiles-2026-08-05" (Opzione B, richiesta Luca):
  // Le celle cliccabili della heatmap frequency (freq_giornaliera) NON vengono
  // piu' caricate tutte insieme (463.574 poligoni = ~100MB = browser lentissimo).
  // Sono state pre-spezzate OFFLINE (split_freq_cells_tiles.py) in 1135 TESSERE
  // geografiche (assets/freq_cells_tiles/<ix>_<iy>.geojson, media ~408 celle
  // l'una) + un index.json. In runtime carico ON-DEMAND SOLO le tessere che
  // ricadono nel VIEWPORT corrente (tipicamente poche decine di migliaia di
  // celle invece di 463k), aggiornandole ad ogni pan/zoom. Il PNG heatmap resta
  // sempre visibile (copre l'intera vista); le celle servono solo per il click
  // che mostra i passaggi/giorno, quindi caricarle solo dove serve NON cambia
  // l'esperienza ma rende la mappa fluida.
  //
  // Stato:
  //   freqTilesIndex   = contenuto di freq_cells_tiles/index.json (tile_deg, map)
  //   freqTilesGroup   = L.LayerGroup che contiene i sotto-layer per tessera
  //   freqTilesLoaded  = Map tileKey -> L.GeoJSON gia' in mappa (per non ricaricare)
  //   freqTilesActive  = true se il layer freq e' acceso (per evitare fetch inutili)
  //   _freqMoveHandler = handler moveend/zoomend agganciato alla mappa
  // Sotto FREQ_TILES_MIN_ZOOM non carico nulla (vista troppo ampia: il PNG basta).
  // ============================================================
  private readonly FREQ_TILES_INDEX_JSON = 'assets/freq_cells_tiles/index.json';
  private readonly FREQ_TILES_DIR = 'assets/freq_cells_tiles/';
  private readonly FREQ_TILES_MIN_ZOOM = 15; // sotto questo zoom: solo PNG, niente celle
  private freqTilesIndex: { tile_deg: number; tiles: { [k: string]: string } } | null = null;
  private freqTilesGroup: L.LayerGroup | null = null;
  private freqTilesLoaded = new Map<string, L.GeoJSON>();
  private freqTilesActive = false;
  private _freqMoveHandler: (() => void) | null = null;

  // ============================================================
  // PATCH-LUCA "grid5m-second-freq-layer-2026-08-24" (richiesta Luca):
  // Stato del SECONDO layer "Heatmap frequency 5x5" (quadrati 5x5 m veri).
  // Stessa identica meccanica on-demand a tessere del layer freq, ma:
  //   - sorgente = assets/grid5m_tiles/ (587k quadrati spezzati in 343 tessere);
  //   - i quadratini sono VISIBILI e COLORATI con la property 'colore' (palette
  //     bianco->rosso scuro, coerente con la heatmap), non trasparenti;
  //   - al click il popup mostra la FREQUENZA GIORNALIERA INTERA (property
  //     'freq', gia' arrotondata per eccesso a monte nella pipeline).
  // Sotto GRID5M_MIN_ZOOM non carico nulla (vista troppo ampia = niente celle);
  // zoomando compaiono solo le tessere del viewport corrente.
  private readonly GRID5M_TILES_INDEX_JSON = 'assets/grid5m_tiles/index.json';
  private readonly GRID5M_TILES_DIR = 'assets/grid5m_tiles/';
  private readonly GRID5M_MIN_ZOOM = 16; // sotto questo zoom: niente quadratini (vista troppo ampia). PATCH-LUCA "grid5m-min-zoom-17-2026-08-24": alzato da 15 a 17 (+2 livelli) perche' a 15 si caricavano ancora troppi quadretti; ora appaiono solo zoomando di piu', da lontano resta la heatmap strade. PATCH-LUCA "grid5m-min-zoom-16-2026-08-24" (richiesta Luca): riabbassato da 17 a 16 (-1 livello) per farli apparire una zoommata piu' indietro
  private grid5mTilesIndex: { tile_deg: number; tiles: { [k: string]: string } } | null = null;
  private grid5mTilesGroup: L.LayerGroup | null = null;
  private grid5mTilesLoaded = new Map<string, L.GeoJSON>();
  private grid5mTilesActive = false;
  private _grid5mMoveHandler: (() => void) | null = null;
  // Renderer canvas dedicato per i quadratini 5x5 (molte migliaia di poligoni).
  private grid5mRenderer: L.Canvas = L.canvas({ padding: 0.5 });

  // PATCH-LUCA "grid5m-loading-spinner-2026-08-24" (richiesta Luca): quando si
  // passa dal PNG (da lontano) ai QUADRATINI (zoom >= soglia), finche' le
  // tessere non sono caricate/disegnate mostro uno spinner con testo di
  // caricamento in inglese ("Loading grid…"). grid5mLoading = true mentre ci
  // sono fetch di tessere pendenti; torna false quando sono TUTTE arrivate.
  // grid5mPending = contatore delle tessere in fetch (per sapere quando finire).
  grid5mLoading = false;
  private grid5mPending = 0;

  // PATCH-LUCA "initial-loading-overlay-2026-09-14" (richiesta Luca): rotella di
  // caricamento INIZIALE mostrata SOLO sulla mappa (overlay #loadingOverlay dentro
  // #map, stile identico alle altre dashboard: box quadrato + spinner viola +
  // "Loading"). Parte a true e viene spenta da hideInitialLoading() quando i primi
  // dati compaiono in mappa (o dopo un timeout di sicurezza). Il template lega
  // [class.is-hidden]="!initialLoading" -> con is-hidden l'overlay sfuma (fade-out
  // CSS) e diventa pointer-events:none, lasciando la mappa cliccabile.
  initialLoading = true;
  // Evita di rieseguire la logica di spegnimento piu' volte.
  private initialLoadingDone = false;
  // PATCH-LUCA "grid5m-spinner-only-on-transition-2026-08-24" (richiesta Luca):
  // lo spinner NON deve comparire quando ci si sposta lateralmente (pan) gia' a
  // zoom alto, ma SOLO nell'istante in cui si ATTRAVERSA la soglia passando dal
  // PNG ai quadretti (da "sotto soglia" a "sopra soglia"). Traccio quindi se al
  // refresh precedente eravamo gia' zoomati dentro: accendo lo spinner solo
  // sulla transizione false->true.
  private grid5mWasZoomedIn = false;

  // PATCH-LUCA "grid5m-png-lod-2026-08-24" (richiesta Luca): il layer "Heatmap
  // frequency 5x5" ha DUE livelli di dettaglio (LOD):
  //   - DA LONTANO (zoom < GRID5M_MIN_ZOOM): mostro la HEATMAP AGGREGATA PER
  //     STRADA (la "heatmap vecchia": corridoi colorati per frequenza lungo
  //     tutta la lunghezza della strada), riusando il PNG heatmap gia' esistente
  //     (heatmap_freq_raster.png), sempre visibile, NON cliccabile (imageOverlay).
  //   - DA VICINO (zoom >= GRID5M_MIN_ZOOM): NASCONDO il PNG e mostro i quadretti
  //     veri 5x5 (bordo visibile, cliccabili), caricati on-demand a tessere.
  // Il PNG e i suoi bounds sono generati AUTOMATICAMENTE dalla pipeline (step 12).
  private grid5mRasterOverlay: L.ImageOverlay | null = null;
  private grid5mRasterBounds: L.LatLngBoundsExpression | null = null;
  // PATCH-LUCA "grid5m-lod-strade-2026-08-24" (richiesta Luca): DA LONTANO NON
  // si mostra piu' la "foto" dei quadratini, ma la HEATMAP AGGREGATA PER STRADA
  // (la "heatmap vecchia": corridoi/strade colorati per frequenza lungo tutta
  // la loro lunghezza). Riuso il PNG gia' esistente della heatmap frequenze
  // (heatmap_freq_raster.png + _bounds.json), leggerissimo. Zoomando (>= soglia)
  // il PNG sparisce e compaiono i quadretti 5x5 cliccabili.
  private readonly GRID5M_RASTER_PNG = 'assets/heatmap_freq_raster.png';
  private readonly GRID5M_RASTER_BOUNDS_JSON = 'assets/heatmap_freq_raster_bounds.json';


  // Legenda a GRADIENTE del raster heatmap frequenze (bianco -> rosso scuro).
  // I 12 stop corrispondono a PALETTE_HEATMAP in _common.py; usati come
  // linear-gradient CSS nel template. minLabel/maxLabel = estremi mostrati
  // sotto la barra ("meno passaggi" -> "piu' passaggi").
  readonly FREQ_RASTER_GRADIENT: string[] = [
    '#ffffff', '#fff0e8', '#fdd8c7', '#fcbba1', '#fc9877', '#fb7551',
    '#f45435', '#e02f21', '#c00f14', '#96000c', '#66000a', '#3d0006',
  ];
  readonly FREQ_RASTER_MIN_LABEL = 'min daily avg';
  readonly FREQ_RASTER_MAX_LABEL = 'max daily avg';

  /** Stringa CSS 'linear-gradient(...)' per la barra legenda del raster. */
  get freqRasterGradientCss(): string {
    return 'linear-gradient(to right, ' + this.FREQ_RASTER_GRADIENT.join(', ') + ')';
  }

  /**
   * PATCH-LUCA "freq-raster-overlay": aggiunge in mappa il raster PNG della
   * heatmap frequenze come imageOverlay (nel linesPane). Carica i bounds una
   * sola volta da assets/..._bounds.json (formato [[south,west],[north,east]]).
   */
  private addFreqRasterOverlay(): void {
    const place = () => {
      if (!this.freqRasterBounds) return;
      if (!this.freqRasterOverlay) {
        this.freqRasterOverlay = L.imageOverlay(this.FREQ_RASTER_PNG, this.freqRasterBounds, {
          pane: 'linesPane',
          opacity: 0.85,
          interactive: false,
          // PATCH-LUCA "freq-raster-smooth-2026-08-05": applico la className
          // 'freq-raster-smooth' (la regola CSS esisteva gia' ma NON era mai
          // assegnata all'overlay -> il browser mostrava il PNG con
          // image-rendering pixelato in zoom, soprattutto su citta' grandi come
          // Madrid dove il PNG copre un'area piu' vasta a densita' px/metro
          // inferiore). La classe forza image-rendering:smooth/high-quality.
          className: 'freq-raster-smooth',
        } as any);
      }
      if (!this.map.hasLayer(this.freqRasterOverlay)) {
        this.freqRasterOverlay.addTo(this.map);
      }
    };
    if (this.freqRasterBounds) { place(); return; }
    fetch(this.FREQ_RASTER_BOUNDS_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        this.zone.run(() => {
          // Il file bounds e' un oggetto { bounds: [[s,w],[n,e]], cella_m }.
          // Accetto sia quell'oggetto sia (retro-compat) un array diretto.
          const b = (data && Array.isArray(data.bounds)) ? data.bounds : data;
          if (Array.isArray(b) && b.length === 2) {
            this.freqRasterBounds = b as L.LatLngBoundsExpression;
            place();
          }
        });
      })
      .catch((err) => { console.error('[freq-raster] bounds non caricati', err); });
  }

  /** PATCH-LUCA "freq-raster-overlay": rimuove il raster PNG dalla mappa. */
  private removeFreqRasterOverlay(): void {
    if (this.freqRasterOverlay && this.map.hasLayer(this.freqRasterOverlay)) {
      this.map.removeLayer(this.freqRasterOverlay);
    }
  }

  // ============================================================
  // PATCH-LUCA "heatmap-raster-tif-layer" (richiesta Luca):
  // TERZO layer "Heatmap raster". Mostra il PNG RGBA tematizzato generato dalla
  // pipeline (step 14) a partire dal raster_heatmap.tif fornito dall'utente in
  // data/. Stessa meccanica di addFreqRasterOverlay (imageOverlay Leaflet nel
  // linesPane, bounds caricati una volta da assets/..._bounds.json), ma con la
  // SUA sorgente PNG/bounds e il SUO overlay dedicato, cosi' e' INDIPENDENTE:
  // puo' restare acceso insieme agli altri layer (nessuna mutua esclusivita').
  // ============================================================
  private rasterHeatmapOverlay: L.ImageOverlay | null = null;
  private rasterHeatmapBounds: L.LatLngBoundsExpression | null = null;
  private readonly RASTER_HEATMAP_PNG = 'assets/heatmap_raster_tematizzato.png';
  private readonly RASTER_HEATMAP_BOUNDS_JSON = 'assets/heatmap_raster_tematizzato_bounds.json';

  // PATCH-LUCA "heatmap-raster-georaster" (richiesta Luca): il layer "Heatmap
  // raster" NON usa piu' il PNG imageOverlay (che in zoom sfocava ai bordi), ma
  // il VERO GeoTIFF (assets/raster_heatmap.tif) letto direttamente nel browser
  // con georaster + georaster-layer-for-leaflet (geotiff.js). Cosi' il raster e'
  // NITIDO come in QGIS a ogni zoom (i quadretti restano netti) ed e'
  // INTERROGABILE: al click sulla mappa leggo il valore del pixel = FREQUENZA
  // GIORNALIERA e apro il popup 'lz-popup' con quel valore.
  //   rasterHeatmapGeoLayer   = istanza GeoRasterLayer in mappa
  //   rasterHeatmapGeoraster  = oggetto georaster parsato (per leggere i valori)
  //   _rasterHeatmapClick     = handler click mappa (per interrogare il pixel)
  private readonly RASTER_HEATMAP_TIF = 'assets/raster_heatmap.tif';
  private rasterHeatmapGeoLayer: any = null;
  private rasterHeatmapGeoraster: any = null;
  private _rasterHeatmapClick: ((e: L.LeafletMouseEvent) => void) | null = null;
  private rasterHeatmapLoading = false;

  // ============================================================
  // PATCH-LUCA "heatmap-freq-by-mode-2026-09-03" (richiesta Luca):
  // Il layer "Heatmap frequency" puo' ora mostrare la frequenza per MODO di
  // trasporto: Total (unione), Metro, Tram, Bus. Ogni modo ha:
  //   - il SUO GeoTIFF grezzo (assets/heatmap_<modo>.tif, valore = somma freq
  //     giornaliera per cella, prodotto dalla pipeline col_heatmap_20260903);
  //   - le SUE 5 soglie "natural breaks (Jenks)" calcolate su QUEL raster
  //     (assets/heatmap_freq_soglie.json, step 7 della pipeline).
  // Un menu "Service type" (radio, selezione singola, stesso stile di quello
  // delle fermate) nella legenda della Heatmap frequency permette di scegliere
  // il modo. Cambiando modo: cambia il .tif mostrato, la funzione-colore (5
  // classi Jenks di quel modo) e la legenda numerica sotto il menu.
  // Default all'accensione: 'unione' (Total).
  // heatmapModeSel   = modo attualmente selezionato ('unione'|'metro'|'tram'|'bus')
  // heatmapSoglie    = contenuto di heatmap_freq_soglie.json (per-modo)
  // HEATMAP_MODES    = opzioni del menu (solo i modi realmente presenti nel JSON)
  // ============================================================
  heatmapModeSel: 'unione' | 'metro' | 'tram' | 'bus' = 'unione';
  private heatmapSoglie: {
    metodo?: string;
    classi_num?: number;
    modi: { [k: string]: { file: string; min: number; max: number; classi: { min: number; max: number; label: string; color: string }[] } };
  } | null = null;
  private heatmapSoglieLoaded = false;
  private readonly HEATMAP_SOGLIE_JSON = 'assets/heatmap_freq_soglie.json';

  // Etichette del menu (label mostrata all'utente). L'ordine e' Total, Metro,
  // Tram, Bus; a runtime filtro solo i modi presenti nel JSON.
  readonly HEATMAP_MODE_DEFS: { key: 'unione' | 'metro' | 'tram' | 'bus'; label: string; noun: string }[] = [
    { key: 'unione', label: 'Total',  noun: 'Total' },
    { key: 'metro',  label: 'Metro',  noun: 'Metro' },
    { key: 'tram',   label: 'Tram',   noun: 'Tram' },
    { key: 'bus',    label: 'Bus',    noun: 'Bus' },
  ];

  /** Modi effettivamente disponibili (presenti nel JSON soglie). Usato dal menu. */
  get availableHeatmapModes(): { key: 'unione' | 'metro' | 'tram' | 'bus'; label: string; noun: string }[] {
    const modi = this.heatmapSoglie?.modi || {};
    return this.HEATMAP_MODE_DEFS.filter((d) => !!modi[d.key]);
  }

  /** True se il menu ha senso (piu' di un modo disponibile). */
  get hasMultipleHeatmapModes(): boolean {
    return this.availableHeatmapModes.length > 1;
  }

  /** Le 5 classi Jenks del modo attualmente selezionato (per la legenda). */
  get heatmapModeClasses(): { min: number; max: number; label: string; color: string }[] {
    const m = this.heatmapSoglie?.modi?.[this.heatmapModeSel];
    return m ? m.classi : [];
  }

  /** Etichetta dinamica sotto il menu, es. "Metro passages (avg daily trips):". */
  get heatmapModeHint(): string {
    // PATCH-LUCA "mono-service-heatmap-hint-2026-11-09" (richiesta Luca): se c'e'
    // UN SOLO modo disponibile (es. Leuven = solo bus), il menu "Service type"
    // non compare e l'etichetta NON deve dire "Total" (che sottintenderebbe piu'
    // modi) ma direttamente il nome di quel modo, es. "Bus passages (avg daily
    // trips):". Con piu' modi resta il comportamento normale (modo selezionato).
    const modes = this.availableHeatmapModes;
    if (modes.length === 1) {
      return `${modes[0].noun} passages (avg daily trips):`;
    }
    const def = this.HEATMAP_MODE_DEFS.find((d) => d.key === this.heatmapModeSel);
    const noun = def ? def.noun : 'Total';
    return `${noun} passages (avg daily trips):`;
  }

  /** Path del .tif del modo selezionato (fallback su raster_heatmap.tif storico). */
  private get heatmapModeTifPath(): string {
    const m = this.heatmapSoglie?.modi?.[this.heatmapModeSel];
    if (m && m.file) return 'assets/' + m.file;
    return this.RASTER_HEATMAP_TIF;
  }

  /**
   * PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": carica (una volta) il JSON
   * con le soglie Jenks per modo. Chiamato in ngAfterViewInit come gli altri
   * asset. Se il modo di default non e' presente, ripiega sul primo disponibile.
   */
  private loadHeatmapSoglie(): void {
    if (this.heatmapSoglieLoaded) return;
    fetch(this.HEATMAP_SOGLIE_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        this.zone.run(() => {
          if (data && data.modi) {
            this.heatmapSoglie = data;
            this.heatmapSoglieLoaded = true;
            // se 'unione' non c'e', prendo il primo modo disponibile
            if (!data.modi[this.heatmapModeSel]) {
              const first = this.availableHeatmapModes[0];
              if (first) this.heatmapModeSel = first.key;
            }
            try { this.cdr.detectChanges(); } catch (e) {}
          }
        });
      })
      .catch((err) => { console.error('[heatmap-freq] soglie non caricate', err); });
  }

  /**
   * PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": colore di un valore-pixel in
   * base alle 5 classi Jenks del MODO selezionato. Cerca la classe la cui
   * fascia [min..max] contiene il valore; l'ultima classe cattura tutto il
   * resto verso l'alto. nodata / v<=0 -> null (trasparente).
   */
  private heatmapModeColorFor(value: number): string | null {
    if (value === null || value === undefined || isNaN(value)) return null;
    if (value <= 0) return null;
    const classi = this.heatmapModeClasses;
    if (!classi || classi.length === 0) {
      // fallback: vecchia palette a soglie fisse
      return this.colorForFrequency(value);
    }
    for (let i = 0; i < classi.length; i++) {
      const c = classi[i];
      if (i === classi.length - 1) return c.color;      // ultima: cattura tutto
      if (value <= c.max) return c.color;
    }
    return classi[classi.length - 1].color;
  }

  /**
   * PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": selezione (radio) del modo
   * dal menu "Service type" della Heatmap frequency. Cambia il modo, ricarica
   * il .tif corrispondente e ridipinge (nuove soglie/colori/legenda). Se il
   * layer Heatmap frequency e' spento, lo accende (come il pulsante).
   */
  onSelectHeatmapMode(mode: 'unione' | 'metro' | 'tram' | 'bus', ev: Event): void {
    ev.stopPropagation();
    if (mode === this.heatmapModeSel && this.activeLayers.has('heatmap_raster')) {
      // gia' selezionato e attivo: niente da fare
      return;
    }
    this.heatmapModeSel = mode;

    // Accende il layer se spento (equivale a premere il pulsante).
    if (!this.activeLayers.has('heatmap_raster')) {
      this.activeLayers.add('heatmap_raster');
      if (!this.isLegendOpen('heatmap_raster')) this.openLegends.add('heatmap_raster');
    }

    // Ricarica l'overlay col .tif del nuovo modo.
    this.reloadRasterHeatmapForMode();
    try { this.cdr.detectChanges(); } catch (e) {}
  }

  /** True se il modo passato e' quello attivo (per il radio del menu). */
  isHeatmapMode(mode: 'unione' | 'metro' | 'tram' | 'bus'): boolean {
    if (!this.activeLayers.has('heatmap_raster')) return false;
    return this.heatmapModeSel === mode;
  }

  /**
   * PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": rimuove l'overlay georaster
   * corrente (se presente) e ne ricrea uno nuovo leggendo il .tif del modo
   * selezionato. Riusa addRasterHeatmapOverlay dopo aver azzerato lo stato.
   */
  private reloadRasterHeatmapForMode(): void {
    // rimuovo overlay e stato del georaster precedente
    if (this.rasterHeatmapGeoLayer && this.map && this.map.hasLayer(this.rasterHeatmapGeoLayer)) {
      this.map.removeLayer(this.rasterHeatmapGeoLayer);
    }
    this.rasterHeatmapGeoLayer = null;
    this.rasterHeatmapGeoraster = null;
    this.rasterHeatmapLoading = false;
    // ricreo con la nuova sorgente
    this.addRasterHeatmapOverlay();
  }


  // Legenda a GRADIENTE del layer "Heatmap raster" (bianco -> rosso scuro),
  // stessa palette PALETTE_HEATMAP degli altri layer heatmap. Usata come
  // linear-gradient CSS nel template della sidebar.
  readonly RASTER_HEATMAP_GRADIENT: string[] = [
    '#ffffff', '#fff0e8', '#fdd8c7', '#fcbba1', '#fc9877', '#fb7551',
    '#f45435', '#e02f21', '#c00f14', '#96000c', '#66000a', '#3d0006',
  ];
  readonly RASTER_HEATMAP_MIN_LABEL = 'low';
  readonly RASTER_HEATMAP_MAX_LABEL = 'high';

  /** Stringa CSS 'linear-gradient(...)' per la barra legenda del raster heatmap. */
  get rasterHeatmapGradientCss(): string {
    return 'linear-gradient(to right, ' + this.RASTER_HEATMAP_GRADIENT.join(', ') + ')';
  }

  /**
   * PATCH-LUCA "heatmap-raster-georaster": converte un valore di frequenza
   * (pixel del .tif) in un colore HEX della palette RASTER_HEATMAP_GRADIENT,
   * con mappatura LINEARE tra min e max del raster. Restituisce null per il
   * nodata / valori <= 0 (celle senza passaggi) cosi' restano TRASPARENTI.
   */
  private rasterHeatmapColorFor(value: number, min: number, max: number): string | null {
    if (value === null || value === undefined || isNaN(value)) return null;
    if (value <= 0) return null; // nodata / nessun passaggio -> trasparente
    const g = this.RASTER_HEATMAP_GRADIENT;
    const span = (max - min) || 1;
    let t = (value - min) / span;
    if (t < 0) t = 0; if (t > 1) t = 1;
    const idx = Math.round(t * (g.length - 1));
    return g[Math.max(0, Math.min(g.length - 1, idx))];
  }

  /**
   * PATCH-LUCA "heatmap-raster-georaster": aggiunge in mappa il VERO GeoTIFF
   * come GeoRasterLayer (nitido come QGIS, interrogabile). Carica/parsea il
   * .tif una sola volta, poi lo aggiunge al linesPane e aggancia il click che
   * mostra la frequenza giornaliera del pixel. Le librerie (parseGeoraster,
   * GeoRasterLayer) sono caricate da CDN nell'index.html.
   */
  private addRasterHeatmapOverlay(): void {
    const place = () => {
      if (!this.rasterHeatmapGeoLayer) return;
      if (!this.map.hasLayer(this.rasterHeatmapGeoLayer)) {
        this.rasterHeatmapGeoLayer.addTo(this.map);
      }
      this.attachRasterHeatmapClick();
    };
    if (this.rasterHeatmapGeoLayer) { place(); return; }
    if (this.rasterHeatmapLoading) return;
    this.rasterHeatmapLoading = true;

    const parseGeoraster = (window as any).parseGeoraster;
    const GeoRasterLayer = (window as any).GeoRasterLayer;
    if (!parseGeoraster || !GeoRasterLayer) {
      console.error('[heatmap-raster] librerie georaster non caricate (index.html)');
      this.rasterHeatmapLoading = false;
      return;
    }

    fetch(this.heatmapModeTifPath)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject('tif non trovato')))
      .then((buf) => parseGeoraster(buf))
      .then((georaster: any) => {
        this.rasterHeatmapGeoraster = georaster;
        // min/max reali del raster (fascia della palette). georaster espone
        // mins/maxs per banda; fallback a 0..max se assenti.
        const min = Array.isArray(georaster.mins) ? georaster.mins[0] : (georaster.min ?? 0);
        const max = Array.isArray(georaster.maxs) ? georaster.maxs[0] : (georaster.max ?? 1);
        const noData = georaster.noDataValue;

        this.rasterHeatmapGeoLayer = new GeoRasterLayer({
          georaster,
          pane: 'linesPane',
          opacity: 0.85,
          // resolution alta = ogni pixel del .tif reso nitido (come QGIS).
          resolution: 256,
          // PATCH-LUCA "heatmap-raster-same-theme-as-freq": la colorazione del
          // raster deve essere IDENTICA agli altri due layer Heatmap frequency,
          // che NON usano un gradiente lineare ma la palette YlOrRd a 5 FASCE
          // (FREQ_LEGEND) via colorForFrequency(). Uso quindi qui la stessa
          // funzione, cosi' i quadretti del .tif hanno esattamente gli stessi
          // 5 colori/soglie (Low/Moderate/High/Very High/Major corridor) delle
          // celle grid5m e degli archi stradali. nodata / v<=0 -> trasparente.
          // PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": la colorazione usa
          // ora le 5 classi "natural breaks (Jenks)" del MODO selezionato
          // (heatmap_freq_soglie.json), non piu' colorForFrequency a soglie
          // fisse. Cosi' Total/Metro/Tram/Bus hanno ciascuno le SUE soglie,
          // esattamente come in QGIS. nodata / v<=0 -> trasparente.
          pixelValuesToColorFn: (values: number[]) => {
            const v = values[0];
            if (v === null || v === undefined || isNaN(v)) return null;
            if (noData !== undefined && noData !== null && v === noData) return null;
            if (v <= 0) return null; // nessun passaggio -> trasparente
            return this.heatmapModeColorFor(v);
          },
        });
        this.zone.run(() => place());
      })
      .catch((err: any) => { console.error('[heatmap-raster] errore caricamento tif', err); })
      .then(() => { this.rasterHeatmapLoading = false; });
  }

  /**
   * PATCH-LUCA "heatmap-raster-georaster": aggancia (una volta) il click sulla
   * mappa che legge il valore del pixel del .tif sotto il punto cliccato e apre
   * un popup 'lz-popup' con la FREQUENZA GIORNALIERA. Usa georaster.geotiff /
   * la lettura per lat-lng tramite gli affini del georaster parsato.
   */
  private attachRasterHeatmapClick(): void {
    if (this._rasterHeatmapClick) return; // gia' agganciato
    this._rasterHeatmapClick = (e: L.LeafletMouseEvent) => {
      const gr = this.rasterHeatmapGeoraster;
      if (!gr) return;
      // Converte lat/lng -> indice colonna/riga nel raster usando origine e
      // dimensione pixel del georaster (xmin/ymax, pixelWidth/pixelHeight).
      const lng = e.latlng.lng;
      const lat = e.latlng.lat;
      if (lng < gr.xmin || lng > gr.xmax || lat < gr.ymin || lat > gr.ymax) return;
      const col = Math.floor((lng - gr.xmin) / gr.pixelWidth);
      const row = Math.floor((gr.ymax - lat) / gr.pixelHeight);
      let val: number | null = null;
      try {
        const band = gr.values[0];
        if (band && band[row] && band[row][col] !== undefined) {
          val = band[row][col];
        }
      } catch (_) { val = null; }
      if (val === null || val === undefined) return;
      if (gr.noDataValue !== undefined && gr.noDataValue !== null && val === gr.noDataValue) return;
      if (val <= 0) return; // nessun passaggio: non mostro popup
      const freq = Math.round(val);
      // PATCH-LUCA "heatmap-raster-popup-like-freq": uso la STESSA funzione
      // popup dei due layer Heatmap frequency (buildFreqCellPopupHtml) e lo
      // stesso className 'lz-popup', cosi' il popup e' IDENTICO agli altri.
      const html = this.buildFreqCellPopupHtml(freq);
      L.popup({ className: 'lz-popup', maxWidth: 260 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(this.map);
    };
    this.map.on('click', this._rasterHeatmapClick);
  }

  /** PATCH-LUCA "heatmap-raster-georaster": rimuove il GeoTIFF dalla mappa e stacca il click. */
  private removeRasterHeatmapOverlay(): void {
    if (this.rasterHeatmapGeoLayer && this.map.hasLayer(this.rasterHeatmapGeoLayer)) {
      this.map.removeLayer(this.rasterHeatmapGeoLayer);
    }
    if (this._rasterHeatmapClick) {
      this.map.off('click', this._rasterHeatmapClick);
      this._rasterHeatmapClick = null;
    }
  }

  // ============================================================
  // PATCH-LUCA "ghsl-pop-tileserver":
  // Layer XYZ da TILE SERVER esterno (nessun download di TIFF/geojson).
  // Leaflet L.tileLayer richiede le singole tile {z}/{x}/{y}.png solo per
  // l'area e lo zoom visibili, come fa ol.source.XYZ in OpenLayers.
  // Usato dal secondo pulsante "Population 2025" (GHSL Copernicus).
  // ============================================================

  /** Accende un layer XYZ (tile server) dato il suo LayerCfg (kind 'xyztiles'). */
  private addXyzTileLayer(l: LayerCfg): void {
    if (!l.tileUrl) return;
    // Se gia' presente, mi limito a riattaccarlo alla mappa.
    let tl = this.xyzTileLayers.get(l.id);
    if (!tl) {
      tl = L.tileLayer(l.tileUrl, {
        pane: 'linesPane',     // sopra la basemap, sotto le fermate
        opacity: 0.85,
        maxZoom: 19,
        crossOrigin: 'anonymous',
        // PATCH-LUCA "ghsl-tms-scheme-2026-08-07": il tile server GHSL usa
        // Web-Mercator (EPSG:3857) MA con l'asse Y invertito (schema TMS).
        // Verificato empiricamente (probe_ghsl_*.py): su Madrid a z=6 la tile
        // XYZ (31,24) e' VUOTA mentre la TMS (31,39) = (2^z-1)-y torna un PNG
        // pieno. Senza tms:true Leaflet chiedeva la riga Y sbagliata (immagine
        // speculare) -> tile vuote -> "non appare nulla". Con tms:true le tile
        // si allineano correttamente alla mappa.
        tms: true,
        attribution: 'GHSL &copy; European Commission, Copernicus',
      } as any);
      this.xyzTileLayers.set(l.id, tl);
    }
    if (!this.map.hasLayer(tl)) tl.addTo(this.map);
  }

  /** Spegne (rimuove dalla mappa) un layer XYZ tile server dato il suo id. */
  private removeXyzTileLayer(id: string): void {
    const tl = this.xyzTileLayers.get(id);
    if (tl && this.map.hasLayer(tl)) {
      this.map.removeLayer(tl);
    }
  }

  /**
   * PATCH-LUCA "freq-raster-cells-click": aggiunge in mappa il layer INVISIBILE
   * ma CLICCABILE delle celle della heatmap frequenze. Caricato una sola volta
   * da assets/heatmap_freq_raster_celle.geojson e messo in cache. Ogni cella:
   *   - stile trasparente (fill/stroke opacity 0) -> non altera l'aspetto del
   *     PNG sottostante, ma resta cliccabile;
   *   - renderer CANVAS (regge ~42k poligoni cliccabili senza appesantire il DOM);
   *   - pane 'stopsPane' (z-index 430) -> sopra il PNG (linesPane 420), cosi'
   *     intercetta il click;
   *   - al click apre un popup 'lz-popup' con la FREQUENZA GIORNALIERA
   *     (passaggi/giorno) di quel punto, coerente col resto della dashboard.
   */
  /**
   * PATCH-LUCA "freq-cells-ondemand-tiles-2026-08-05": accende il sistema di
   * celle cliccabili ON-DEMAND. Invece di caricare l'unico file da 100MB,
   * carica l'index delle tessere (una volta), crea un LayerGroup e aggancia un
   * handler moveend/zoomend che carica SOLO le tessere nel viewport corrente.
   * Il click su una cella continua ad aprire il popup con freq_giornaliera.
   */
  private addFreqCellsLayer(): void {
    this.freqTilesActive = true;

    // Crea (una sola volta) il LayerGroup contenitore delle tessere.
    if (!this.freqTilesGroup) {
      this.freqTilesGroup = L.layerGroup();
    }
    if (!this.map.hasLayer(this.freqTilesGroup)) {
      this.freqTilesGroup.addTo(this.map);
    }

    // Aggancia (una sola volta) l'handler che ricarica le tessere visibili
    // ad ogni fine spostamento/zoom della mappa.
    if (!this._freqMoveHandler) {
      this._freqMoveHandler = () => {
        this.zone.runOutsideAngular(() => this.refreshFreqTilesInView());
      };
      this.map.on('moveend', this._freqMoveHandler);
      this.map.on('zoomend', this._freqMoveHandler);
    }

    // Carica l'index delle tessere (una sola volta), poi popola la vista.
    if (this.freqTilesIndex) {
      this.refreshFreqTilesInView();
      return;
    }
    fetch(this.FREQ_TILES_INDEX_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => {
        this.zone.run(() => {
          if (!idx || !idx.tiles) {
            console.error('[freq-cells] index tessere non valido');
            return;
          }
          this.freqTilesIndex = idx;
          // Se nel frattempo il layer freq e' stato spento, non faccio nulla.
          if (!this.freqTilesActive) return;
          this.refreshFreqTilesInView();
        });
      })
      .catch((err) => { console.error('[freq-cells] index tessere non caricato', err); });
  }

  /**
   * Carica le tessere delle celle freq che intersecano il viewport corrente e
   * scarica quelle uscite dalla vista, mantenendo il DOM/canvas leggero. Sotto
   * FREQ_TILES_MIN_ZOOM (vista troppo ampia) rimuove tutte le celle: il PNG da
   * solo copre gia' la heatmap, quindi non serve caricare centinaia di tessere.
   */
  private refreshFreqTilesInView(): void {
    if (!this.freqTilesActive || !this.freqTilesIndex || !this.freqTilesGroup) return;
    const deg = this.freqTilesIndex.tile_deg;
    const wanted = new Set<string>();

    // A zoom basso NON carico celle (solo PNG): svuoto tutto ed esco.
    if (this.map.getZoom() >= this.FREQ_TILES_MIN_ZOOM) {
      const b = this.map.getBounds().pad(0.15); // piccolo margine oltre il bordo
      const ix0 = Math.floor(b.getWest() / deg);
      const ix1 = Math.floor(b.getEast() / deg);
      const iy0 = Math.floor(b.getSouth() / deg);
      const iy1 = Math.floor(b.getNorth() / deg);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const key = ix + '_' + iy;
          if (this.freqTilesIndex.tiles[key]) wanted.add(key);
        }
      }
    }

    // Rimuovo le tessere non piu' desiderate (uscite dalla vista o zoom-out).
    for (const [key, lyr] of this.freqTilesLoaded) {
      if (!wanted.has(key)) {
        this.freqTilesGroup.removeLayer(lyr);
        this.freqTilesLoaded.delete(key);
      }
    }

    // Carico le tessere mancanti (fetch del solo file di quella tessera).
    for (const key of wanted) {
      if (this.freqTilesLoaded.has(key)) continue;
      // Segnaposto immediato per evitare doppi fetch della stessa tessera.
      const placeholder = L.geoJSON(undefined as any);
      this.freqTilesLoaded.set(key, placeholder);
      const fname = this.freqTilesIndex.tiles[key];
      fetch(this.FREQ_TILES_DIR + fname)
        .then((r) => (r.ok ? r.json() : null))
        .then((gj) => {
          // Se nel frattempo il layer e' stato spento o la tessera e' uscita
          // dalla vista, non aggiungo nulla.
          if (!gj || !this.freqTilesActive || !this.freqTilesGroup) return;
          if (this.freqTilesLoaded.get(key) !== placeholder) return; // gia' sostituita
          const tileLayer = L.geoJSON(gj, {
            pane: 'stopsPane',
            renderer: this.freqCellsRenderer,
            // Stile TOTALMENTE trasparente: la cella non si vede (il colore lo
            // da' il PNG sotto), ma resta interattiva per il click.
            style: () => ({ stroke: false, weight: 0, opacity: 0, fill: true, fillOpacity: 0 }),
            onEachFeature: (f: any, lyr: any) => {
              const raw = f?.properties?.['freq_giornaliera'];
              const n = typeof raw === 'number' ? raw : parseFloat(raw);
              const val = isNaN(n) ? 0 : n;
              const html = this.buildFreqCellPopupHtml(val);
              (lyr as any).bindPopup(html, { className: 'lz-popup', maxWidth: 260 });
            },
          } as any);
          this.freqTilesLoaded.set(key, tileLayer);
          this.freqTilesGroup.addLayer(tileLayer);
        })
        .catch((err) => {
          console.error('[freq-cells] tessera non caricata', fname, err);
          // libero il segnaposto cosi' un futuro refresh possa ritentare
          if (this.freqTilesLoaded.get(key) === placeholder) this.freqTilesLoaded.delete(key);
        });
    }
  }

  /** PATCH-LUCA "freq-cells-ondemand-tiles-2026-08-05": rimuove TUTTE le celle
   *  cliccabili dalla mappa (tessere caricate) e stacca gli handler di vista. */
  private removeFreqCellsLayer(): void {
    this.freqTilesActive = false;
    if (this._freqMoveHandler) {
      this.map.off('moveend', this._freqMoveHandler);
      this.map.off('zoomend', this._freqMoveHandler);
      this._freqMoveHandler = null;
    }
    if (this.freqTilesGroup) {
      this.freqTilesGroup.clearLayers();
      if (this.map.hasLayer(this.freqTilesGroup)) this.map.removeLayer(this.freqTilesGroup);
    }
    this.freqTilesLoaded.clear();
  }

  // ============================================================
  // PATCH-LUCA "grid5m-second-freq-layer-2026-08-24" (richiesta Luca):
  // Funzioni del SECONDO layer "Heatmap frequency 5x5" (quadrati 5x5 m).
  // Copia fedele di addFreqCellsLayer/refreshFreqTilesInView/removeFreqCellsLayer
  // ma con la sua sorgente (grid5m_tiles), i quadratini VISIBILI/colorati e il
  // popup sulla property 'freq'.
  // ============================================================

  /** Accende il sistema di quadratini 5x5 ON-DEMAND (2o layer Heatmap frequency). */
  private addGrid5mCellsLayer(): void {
    this.grid5mTilesActive = true;

    // PATCH-LUCA "grid5m-png-lod-2026-08-24": carico anche il PNG "foto" dei
    // quadratini, che verra' mostrato/nascosto in base allo zoom da
    // refreshGrid5mTilesInView (da lontano PNG, da vicino quadretti).
    this.ensureGrid5mRasterBounds();

    if (!this.grid5mTilesGroup) {
      this.grid5mTilesGroup = L.layerGroup();
    }
    if (!this.map.hasLayer(this.grid5mTilesGroup)) {
      this.grid5mTilesGroup.addTo(this.map);
    }

    if (!this._grid5mMoveHandler) {
      this._grid5mMoveHandler = () => {
        this.zone.runOutsideAngular(() => this.refreshGrid5mTilesInView());
      };
      this.map.on('moveend', this._grid5mMoveHandler);
      this.map.on('zoomend', this._grid5mMoveHandler);
    }

    if (this.grid5mTilesIndex) {
      this.refreshGrid5mTilesInView();
      return;
    }
    fetch(this.GRID5M_TILES_INDEX_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => {
        this.zone.run(() => {
          if (!idx || !idx.tiles) {
            console.error('[grid5m] index tessere non valido');
            return;
          }
          this.grid5mTilesIndex = idx;
          if (!this.grid5mTilesActive) return;
          this.refreshGrid5mTilesInView();
        });
      })
      .catch((err) => { console.error('[grid5m] index tessere non caricato', err); });
  }

  /** Carica/scarica le tessere dei quadratini 5x5 in base al viewport corrente. */
  private refreshGrid5mTilesInView(): void {
    if (!this.grid5mTilesActive || !this.grid5mTilesIndex || !this.grid5mTilesGroup) return;
    const deg = this.grid5mTilesIndex.tile_deg;
    const wanted = new Set<string>();

    // PATCH-LUCA "grid5m-png-lod-2026-08-24": LOD a due livelli.
    //   - Se lo zoom e' SOTTO la soglia (vista ampia): mostro il PNG "foto" e
    //     NON carico quadretti (wanted resta vuoto -> tutte le tessere rimosse).
    //   - Se lo zoom e' SOPRA la soglia (dettaglio): NASCONDO il PNG e carico le
    //     tessere di quadretti veri nel viewport.
    const zoomedIn = this.map.getZoom() >= this.GRID5M_MIN_ZOOM;
    // PATCH-LUCA "grid5m-spinner-only-on-transition-2026-08-24": true SOLO
    // nell'istante in cui si passa da PNG (fuori) a quadretti (dentro). Un
    // semplice pan a zoom alto NON e' una transizione (era gia' zoomedIn), quindi
    // lo spinner non comparira'.
    const justCrossedIntoDetail = zoomedIn && !this.grid5mWasZoomedIn;
    this.grid5mWasZoomedIn = zoomedIn;
    if (zoomedIn) {
      this.hideGrid5mRaster();
    } else {
      this.showGrid5mRaster();
      // PATCH-LUCA "grid5m-loading-spinner-2026-08-24": a zoom basso (solo PNG)
      // non c'e' nessun caricamento di quadretti -> spinner sempre spento.
      this.setGrid5mLoading(false);
    }

    if (zoomedIn) {
      const b = this.map.getBounds().pad(0.15);
      const ix0 = Math.floor(b.getWest() / deg);
      const ix1 = Math.floor(b.getEast() / deg);
      const iy0 = Math.floor(b.getSouth() / deg);
      const iy1 = Math.floor(b.getNorth() / deg);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const key = ix + '_' + iy;
          if (this.grid5mTilesIndex.tiles[key]) wanted.add(key);
        }
      }
    }

    for (const [key, lyr] of this.grid5mTilesLoaded) {
      if (!wanted.has(key)) {
        this.grid5mTilesGroup.removeLayer(lyr);
        this.grid5mTilesLoaded.delete(key);
      }
    }

    // PATCH-LUCA "grid5m-loading-spinner-2026-08-24": conto quante tessere NUOVE
    // devo caricare (non ancora in cache). Se ce ne sono, accendo lo spinner
    // "Loading grid…".
    // PATCH-LUCA "grid5m-spinner-only-on-transition-2026-08-24" (richiesta Luca):
    // accendo lo spinner SOLO quando ho appena ATTRAVERSATO la soglia PNG->
    // quadretti (justCrossedIntoDetail). Se e' un semplice PAN a zoom alto (gia'
    // dentro) NON mostro lo spinner, anche se entrano nuove tessere: i quadretti
    // extra si caricano silenziosamente ai bordi.
    const toLoad: string[] = [];
    for (const key of wanted) {
      if (!this.grid5mTilesLoaded.has(key)) toLoad.push(key);
    }
    if (justCrossedIntoDetail && toLoad.length > 0) {
      this.grid5mPending += toLoad.length;
      this.setGrid5mLoading(true);
    }
    // Solo se lo spinner e' stato acceso ORA (transizione) le tessere di questo
    // batch devono decrementare il contatore alla fine. Su un pan (spinner non
    // acceso) i fetch NON toccano il contatore.
    const countsForSpinner = justCrossedIntoDetail && toLoad.length > 0;

    for (const key of toLoad) {
      const placeholder = L.geoJSON(undefined as any);
      this.grid5mTilesLoaded.set(key, placeholder);
      const fname = this.grid5mTilesIndex.tiles[key];
      fetch(this.GRID5M_TILES_DIR + fname)
        .then((r) => (r.ok ? r.json() : null))
        .then((gj) => {
          if (!gj || !this.grid5mTilesActive || !this.grid5mTilesGroup) return;
          if (this.grid5mTilesLoaded.get(key) !== placeholder) return;
          const tileLayer = L.geoJSON(gj, {
            pane: 'stopsPane',
            renderer: this.grid5mRenderer,
            // Quadratini 5x5 VISIBILI: colore dalla property 'colore' (palette
            // bianco->rosso scuro coerente con la heatmap). PATCH-LUCA
            // "grid5m-visible-border-2026-08-24" (richiesta Luca): il BORDO deve
            // essere TUTTO VISIBILE -> uso un contorno grigio scuro netto e
            // opaco (weight 1, opacity 1) cosi' ogni quadretto e' ben delimitato.
            style: (f: any) => {
              const col = String(f?.properties?.['colore'] ?? '').trim() || '#bd0026';
              return { stroke: true, color: '#333333', weight: 1, opacity: 1,
                       fill: true, fillColor: col, fillOpacity: 0.9 };
            },
            onEachFeature: (f: any, lyr: any) => {
              const raw = f?.properties?.['freq'];
              const n = typeof raw === 'number' ? raw : parseFloat(raw);
              const val = isNaN(n) ? 0 : n;
              const html = this.buildFreqCellPopupHtml(val);
              (lyr as any).bindPopup(html, { className: 'lz-popup', maxWidth: 260 });
            },
          } as any);
          this.grid5mTilesLoaded.set(key, tileLayer);
          this.grid5mTilesGroup.addLayer(tileLayer);
        })
        .catch((err) => {
          console.error('[grid5m] tessera non caricata', fname, err);
          if (this.grid5mTilesLoaded.get(key) === placeholder) this.grid5mTilesLoaded.delete(key);
        })
        .finally(() => {
          // PATCH-LUCA "grid5m-spinner-only-on-transition-2026-08-24": decremento
          // il contatore SOLO se questo batch era quello della transizione che ha
          // acceso lo spinner. Su un pan (countsForSpinner=false) non tocco nulla.
          if (!countsForSpinner) return;
          this.grid5mPending = Math.max(0, this.grid5mPending - 1);
          if (this.grid5mPending === 0) this.setGrid5mLoading(false);
        });
    }
  }

  /** PATCH-LUCA "grid5m-loading-spinner-2026-08-24": accende/spegne lo spinner
   *  di caricamento dei quadratini, forzando il change-detection Angular
   *  (le fetch girano fuori dalla zone per performance). */
  private setGrid5mLoading(on: boolean): void {
    if (this.grid5mLoading === on) return;
    this.zone.run(() => {
      this.grid5mLoading = on;
      if (!on) this.grid5mPending = 0;
    });
  }

  /**
   * PATCH-LUCA "initial-loading-overlay-2026-09-14" (richiesta Luca): spegne la
   * rotella di caricamento INIZIALE sulla mappa (overlay #loadingOverlay).
   * Idempotente: la prima chiamata mette initialLoading=false (il template
   * aggiunge .is-hidden all'overlay, che sfuma via CSS e diventa
   * pointer-events:none). Le chiamate successive non fanno nulla. Girata dentro
   * la NgZone perche' puo' essere invocata da timeout/eventi Leaflet.
   */
  private hideInitialLoading(): void {
    if (this.initialLoadingDone) return;
    this.initialLoadingDone = true;
    this.zone.run(() => {
      this.initialLoading = false;
      try { this.cdr.detectChanges(); } catch (e) {}
    });
  }

  /** Spegne il layer quadratini 5x5: rimuove le tessere e stacca gli handler. */
  private removeGrid5mCellsLayer(): void {
    this.grid5mTilesActive = false;
    if (this._grid5mMoveHandler) {
      this.map.off('moveend', this._grid5mMoveHandler);
      this.map.off('zoomend', this._grid5mMoveHandler);
      this._grid5mMoveHandler = null;
    }
    if (this.grid5mTilesGroup) {
      this.grid5mTilesGroup.clearLayers();
      if (this.map.hasLayer(this.grid5mTilesGroup)) this.map.removeLayer(this.grid5mTilesGroup);
    }
    this.grid5mTilesLoaded.clear();
    // PATCH-LUCA "grid5m-png-lod-2026-08-24": spegnendo il layer rimuovo anche
    // il PNG "foto" dei quadratini dalla mappa.
    this.hideGrid5mRaster();
    // PATCH-LUCA "grid5m-loading-spinner-2026-08-24": spegnendo il layer
    // azzero anche lo spinner di caricamento.
    this.setGrid5mLoading(false);
    // PATCH-LUCA "grid5m-spinner-only-on-transition-2026-08-24": resetto lo
    // stato "eravamo zoomati dentro" cosi' alla RIACCENSIONE del layer la
    // transizione PNG->quadretti viene di nuovo rilevata correttamente.
    this.grid5mWasZoomedIn = false;
  }

  // ============================================================
  // PATCH-LUCA "grid5m-png-lod-2026-08-24": gestione del PNG "foto" dei
  // quadratini (LOD da lontano). Carica i bounds una sola volta, poi mostra o
  // nasconde l'imageOverlay in base allo zoom (chiamato da refreshGrid5mTilesInView).
  // ============================================================

  /** Carica (una volta) i bounds del PNG grid5m da assets/..._bounds.json. */
  private ensureGrid5mRasterBounds(): void {
    if (this.grid5mRasterBounds) return;
    fetch(this.GRID5M_RASTER_BOUNDS_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        this.zone.run(() => {
          // Formato { bounds: [[s,w],[n,e]], cella_m } (o array diretto).
          const b = (data && Array.isArray(data.bounds)) ? data.bounds : data;
          if (Array.isArray(b) && b.length === 2) {
            this.grid5mRasterBounds = b as L.LatLngBoundsExpression;
            // Se il layer e' attivo e siamo a zoom basso, mostro subito il PNG.
            if (this.grid5mTilesActive && this.map.getZoom() < this.GRID5M_MIN_ZOOM) {
              this.showGrid5mRaster();
            }
          }
        });
      })
      .catch((err) => { console.error('[grid5m-raster] bounds non caricati', err); });
  }

  /** Mostra il PNG "foto" dei quadratini (LOD da lontano), non cliccabile. */
  private showGrid5mRaster(): void {
    if (!this.grid5mTilesActive || !this.grid5mRasterBounds) return;
    if (!this.grid5mRasterOverlay) {
      this.grid5mRasterOverlay = L.imageOverlay(this.GRID5M_RASTER_PNG, this.grid5mRasterBounds, {
        pane: 'linesPane',
        // PATCH-LUCA "grid5m-raster-thicker-2026-08-24" (richiesta Luca): da
        // lontano le strade della heatmap si vedevano poco/sottili. Per
        // ingrossarle visivamente porto l'opacita' a piena (1.0) e applico la
        // className 'grid5m-raster-bold' che, via CSS, ispessisce i tratti con
        // un leggero contrasto/saturazione (image-rendering + filter). Cosi' da
        // lontano e medio-lontano i corridoi risaltano di piu'.
        opacity: 1.0,
        interactive: false,
        className: 'freq-raster-smooth grid5m-raster-bold',
      } as any);
    }
    if (!this.map.hasLayer(this.grid5mRasterOverlay)) {
      this.grid5mRasterOverlay.addTo(this.map);
    }
  }

  /** Nasconde il PNG "foto" dei quadratini (quando compaiono i quadretti veri). */
  private hideGrid5mRaster(): void {
    if (this.grid5mRasterOverlay && this.map.hasLayer(this.grid5mRasterOverlay)) {
      this.map.removeLayer(this.grid5mRasterOverlay);
    }
  }

  /** HTML del popup di una cella della heatmap frequenze: mostra i passaggi
   *  medi giornalieri (freq_giornaliera) in quel punto, con card coerente. */
  private buildFreqCellPopupHtml(freqDaily: number): string {
    const val = Math.round(freqDaily).toLocaleString('en-US');
    return `
      <div class="lzp" style="font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;min-width:150px">
        <div style="font-weight:700;color:#111827;letter-spacing:.2px;margin-bottom:4px">
          Heatmap frequency
        </div>
        <div style="display:flex;align-items:baseline;gap:6px">
          <span style="font-size:20px;font-weight:800;color:#bd0026">${val}</span>
          <span style="font-size:12px;color:#4b5563">avg daily trips</span>
        </div>
      </div>`;
  }


  // PATCH-LUCA "line-style-toggle":
  // Modalita' di rendering delle Transit lines:
  //   'qml'    -> heatmap frequenza (default, palette YlOrRd dal QML)
  //   'livery' -> livrea ufficiale De Lijn (comportamento precedente)
  // Il toggle nella legenda dell'accordion "Transit lines" alterna le due
  // modalita' e cambia in tempo reale sia i colori in mappa sia la legenda.
  lineStyleMode: 'qml' | 'livery' = 'qml';

  /** Ritorna il colore heatmap per una tratta in base al campo 'frequency'. */
  private colorForFrequency(freq: any): string {
    const n = typeof freq === 'number' ? freq : parseFloat(freq);
    const val = isNaN(n) ? 0 : n;
    for (const b of this.FREQ_LEGEND) {
      if (val >= b.range[0] && val <= b.range[1]) return b.color;
    }
    // sotto 1 (o mancante): usa il colore piu' chiaro
    return this.FREQ_LEGEND[0].color;
  }

  /**
   * Ritorna le PathOptions per una feature 'linea' in base alla modalita' attiva.
   * - 'qml'    : colore = fascia frequenza, weight 2.5
   * - 'livery' : colore = livrea De Lijn (campo geojson 'color'), weight 2.5
   *   Il bianco delle Night lines viene mantenuto tale (nessun remap).
   */
  private styleForLine(f: any): L.PathOptions {
    if (this.lineStyleMode === 'qml') {
      // PATCH-LUCA "freq-heatmap-strade": in modalita' 'qml' il layer attivo e'
      // "Heatmap frequency" sugli ARCHI STRADALI. Ogni arco ha gia' il campo
      // 'colore' (palette YlOrRd tematizzata in QGIS sullo step 7). Lo uso
      // direttamente; se mancasse, fallback su colorForFrequency della
      // freq_giornaliera. weight leggermente maggiore per leggibilita' su
      // ortofoto.
      const p = f?.properties || {};
      const rawCol = String(p['colore'] ?? '').trim();
      const color = rawCol
        ? this.normalizeColor(rawCol)
        : this.colorForFrequency(p['freq_giornaliera']);
      return {
        color,
        weight: 3,
        opacity: 0.95,
        lineJoin: 'round',
        lineCap: 'round',
      };
    }
    // livery
    // PATCH-LUCA "night-white": ripristinato il colore BIANCO originale per le
    // Night lines (400s, 500s, 597, 609, ...). In precedenza il bianco #FFFFFF
    // veniva rimappato a grigio scuro per leggibilita' su Carto Light, ma
    // (a) altre basemap scelte dall'utente lo mostrano correttamente e
    // (b) l'utente ha richiesto esplicitamente di rimetterlo bianco.
    const raw = (f?.properties && f.properties['color']) || '#53006c';
    const color = this.normalizeColor(raw);
    return {
      color,
      weight: 2.5,
      opacity: 0.85,
      lineJoin: 'round',
      lineCap: 'round',
    };
  }

  /**
   * Handler del toggle nella legenda "Transit lines". Alterna la modalita'
   * di rendering e, se il layer e' gia' in mappa, ne aggiorna lo stile senza
   * ricaricare il geojson.
   */
  onToggleLineStyleMode(ev: Event): void {
    ev.stopPropagation();
    this.lineStyleMode = this.lineStyleMode === 'qml' ? 'livery' : 'qml';
    const layer = this.layerCache.get('heatmap_lines_livery');
    if (layer) {
      layer.setStyle((f: any) => this.styleForLine(f));
    }
  }

  // ============================================================
  // PATCH-LUCA "livery-legend-select":
  // Selezione interattiva delle linee dalla legenda "Transport lines" (livery).
  //   - Click su una riga colore -> in mappa restano SOLO le linee di quel
  //     colore; in legenda le altre righe diventano semi-trasparenti e solo
  //     quella cliccata resta "accesa".
  //   - Click su un'ALTRA riga -> selezione MULTIPLA: in mappa compaiono anche
  //     le linee di quel colore (si aggiunge).
  //   - Ri-click su una riga gia' selezionata -> si deseleziona (sparisce dalla
  //     mappa), restano le altre.
  //   - Click su un punto VUOTO della legenda (non su una riga) -> reset: tutte
  //     le righe tornano selezionate e in mappa riappaiono tutte le linee.
  //
  // Il filtro e' basato sul COLORE normalizzato (property 'color' del geojson):
  // cosi' una voce come "Night lines" (tutte bianche) o "Lines 40, 2" (stesso
  // colore) viene gestita correttamente in un colpo solo.
  // selectedLiveryColors VUOTO = nessun filtro = tutte le linee visibili.
  // ============================================================
  selectedLiveryColors = new Set<string>();

  // ============================================================
  // PATCH-LUCA "livery-legend-expand-sublines" (2026-07-29, richiesta Luca):
  // Le voci della legenda con PIU' linee (es. "Lines 20, 79, R92") diventano
  // ESPANDIBILI: cliccando la freccetta si aprono le singole linee come
  // sotto-voci (Line 20 / Line 79 / Line R92). Cliccando una singola
  // sotto-linea, in mappa resta visibile SOLO quella specifica linea (filtro
  // per property 'line', non piu' per colore -> non tutte le linee dello
  // stesso colore).
  //
  // Stato:
  //   expandedLegendColors = colori (normalizzati) delle righe attualmente
  //                          espanse nella legenda.
  //   selectedLiveryLines  = numeri di linea (property 'line') selezionati
  //                          come SINGOLE linee. Quando NON e' vuoto, il filtro
  //                          mappa mostra SOLO queste linee (ha priorita' sul
  //                          filtro per colore selectedLiveryColors).
  // ============================================================
  expandedLegendColors = new Set<string>();
  selectedLiveryLines = new Set<string>();

  /** Estrae dalla label di legenda l'elenco delle singole linee.
   *  "Lines 20, 79, R92" -> ['20','79','R92'];  "Line 1" -> ['1'];
   *  PATCH-LUCA "night-lines-real-list" (2026-07-29): per le "Night lines" NON
   *  uso piu' i 4 token dell'etichetta (400s/500s/597/609 = solo un riassunto
   *  con i "..."), ma leggo dal geojson gia' caricato (dataCache['lines']) i
   *  NUMERI REALI di TUTTE le linee BIANCHE (#FFFFFF): sono 29 (178,179,206,
   *  295,296,406,426,500,520...631), ordinate numericamente. Cosi' ogni
   *  sotto-voce e' una linea vera, cliccabile e filtrante correttamente
   *  (match esatto sul campo 'line'). Se il geojson non e' ancora pronto,
   *  fallback ai token dell'etichetta. */
  legendSubLines(name: string): string[] {
    if (!name) return [];
    // Caso Night lines: prendo le linee BIANCHE reali dal dataset.
    if (/night/i.test(name)) {
      const real = this.nightLineNumbers();
      if (real.length) return real;
      // fallback: token dentro le parentesi dell'etichetta
      const m = name.match(/\(([^)]*)\)/);
      if (!m) return [];
      // PATCH-LUCA "sublines-alphanumeric-codes-2026-09-04": stesso criterio
      // tollerante ai codici alfanumerici usato sopra (N1, T31, SE702, 500s...).
      return m[1].split(',').map((s) => s.trim()).filter((s) => {
        const t = s.trim();
        if (!t || t === '…' || t === '...') return false;
        if (/^[a-z0-9]+$/i.test(t) && /\d/.test(t)) return true; // codici con cifre (500s, N1, SE702)
        if (/^[a-z]{1,3}$/i.test(t)) return true;                 // sole lettere brevi (A, H)
        return false;
      });
    }
    // rimuovo il prefisso "Line"/"Lines" e prendo i token separati da virgola
    const body = name.replace(/^\s*lines?\s+/i, '');
    const parts = body.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    // PATCH-LUCA "sublines-alphanumeric-codes-2026-09-04" (richiesta Luca):
    // Prima il filtro era /^r?\d+[a-z]?$/i, pensato per Leuven (1, 5a, R92):
    // accettava SOLO cifre con al piu' una "R" iniziale e una lettera finale.
    // Su reti con codici ALFANUMERICI (N1, T31, C03, NC1, SC2, SE702, BR1, ...)
    // quei token venivano SCARTATI, quindi espandendo una voce comparivano solo
    // le linee puramente numeriche e le varianti con lettere sparivano.
    // Ora accetto QUALSIASI codice linea alfanumerico:
    //   - token con almeno una cifra ed eventuali lettere in qualsiasi
    //     posizione (N13, T31, C03, NC1, SC2, SE702, BR1, 172SF, 5a, R92, ...);
    //   - token di sole lettere brevi come "A"/"H" (max 3 lettere), che sono
    //     comunque nomi di linea validi nel dataset.
    // Escludo solo i token vuoti o palesemente non-linea (es. "..." del riassunto Night).
    const isLineToken = (s: string): boolean => {
      const t = s.trim();
      if (!t) return false;
      if (t === '…' || t === '...') return false;
      // codice con almeno una cifra e solo caratteri alfanumerici (lettere+cifre)
      if (/^[a-z0-9]+$/i.test(t) && /\d/.test(t)) return true;
      // codice di sole lettere corto (A, H, SF, ...) -> ammesso come linea valida
      if (/^[a-z]{1,3}$/i.test(t)) return true;
      return false;
    };
    const lines = parts.filter(isLineToken);
    return lines;
  }

  /** Numeri REALI (property 'line') di tutte le linee BIANCHE (#FFFFFF = Night)
   *  presenti nel geojson caricato, ordinati numericamente crescente.
   *  Il risultato viene messo in cache (nightLinesCache) per non riscandire il
   *  dataset ad ogni change-detection. PATCH-LUCA "night-lines-real-list". */
  private nightLinesCache: string[] | null = null;
  private nightLineNumbers(): string[] {
    if (this.nightLinesCache) return this.nightLinesCache;
    const gj = this.dataCache['lines'];
    const feats: any[] = (gj && Array.isArray(gj.features)) ? gj.features : [];
    if (!feats.length) return []; // non ancora caricato
    const set = new Set<string>();
    for (const f of feats) {
      const col = this.normalizeColor(String(f?.properties?.['color'] ?? '')).toLowerCase();
      if (col !== '#ffffff') continue;
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (ln) set.add(ln);
    }
    const arr = Array.from(set).sort((a, b) => {
      const na = parseInt(a.replace(/^r/i, ''), 10);
      const nb = parseInt(b.replace(/^r/i, ''), 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
    this.nightLinesCache = arr;
    return arr;
  }



  /** True se una voce di legenda ha piu' di una linea (quindi e' espandibile). */
  isLegendRowExpandable(name: string): boolean {
    return this.legendSubLines(name).length > 1;
  }

  /** True se la riga di legenda (per colore) e' attualmente espansa. */
  isLegendRowExpanded(color: string): boolean {
    return this.expandedLegendColors.has(this.normalizeColor(color));
  }

  /** Apre/chiude l'espansione delle sotto-linee di una riga di legenda.
   *  stopPropagation per non far scattare la selezione del colore ne' il reset. */
  onToggleLegendExpand(color: string, ev: Event): void {
    ev.stopPropagation();
    const norm = this.normalizeColor(color);
    if (this.expandedLegendColors.has(norm)) this.expandedLegendColors.delete(norm);
    else this.expandedLegendColors.add(norm);
  }

  /** True se una SINGOLA sotto-linea e' selezionata (accesa).
   *  PATCH-LUCA "subline-uses-linekeys-2026-09-01": ora guarda il set NUOVO
   *  selectedLiveryLineKeys (chiavi 'mode|line') e considera accesa la linea
   *  anche se il suo MODO intero e' selezionato. Se nessun filtro e' attivo
   *  (entrambi i set vuoti) tutte le linee sono accese. */
  isLiveryLineSelected(line: string): boolean {
    const ln = String(line).trim();
    if (!ln) return false;
    // Nessun filtro attivo -> tutte accese.
    if (this.selectedLiveryModes.size === 0 && this.selectedLiveryLineKeys.size === 0) {
      return true;
    }
    // Linea accesa se una qualsiasi chiave 'mode|line' e' presente...
    for (const k of this.selectedLiveryLineKeys) {
      const idx = k.indexOf('|');
      if (idx >= 0 && k.slice(idx + 1) === ln) return true;
    }
    // ...oppure se il MODO a cui appartiene la linea e' interamente acceso.
    for (const m of this.modesForLine(ln)) {
      if (this.selectedLiveryModes.has(m)) return true;
    }
    return false;
  }

  /**
   * PATCH-LUCA "subline-selected-per-mode-2026-09-09" (richiesta Luca):
   * True se una SINGOLA sotto-linea di uno SPECIFICO MODO e' accesa nella legenda.
   * A differenza di isLiveryLineSelected(line) -- che guardava SOLO il numero di
   * linea e quindi accendeva erroneamente ANCHE la stessa linea in un altro modo
   * (es. selezionando la metro 4, in legenda si illuminava pure il bus 4) -- qui
   * uso la chiave UNIVOCA 'mode|line', cosi' l'evidenziazione in legenda riguarda
   * SOLO la riga del modo cliccato. La linea e' accesa se:
   *   - nessun filtro attivo (entrambi i set vuoti) -> tutte accese;
   *   - la chiave esatta 'mode|line' e' in selectedLiveryLineKeys; oppure
   *   - il MODO intero (grp.key) e' selezionato in selectedLiveryModes.
   */
  isLiverySubLineSelected(line: string, mode: string): boolean {
    const ln = String(line).trim();
    const m = String(mode || '').trim();
    if (!ln || !m) return false;
    // Nessun filtro attivo -> tutte accese.
    if (this.selectedLiveryModes.size === 0 && this.selectedLiveryLineKeys.size === 0) {
      return true;
    }
    // Il MODO intero e' acceso -> tutte le sue linee sono accese.
    if (this.selectedLiveryModes.has(m)) return true;
    // La chiave esatta 'mode|line' e' selezionata.
    return this.selectedLiveryLineKeys.has(m + '|' + ln);
  }

  /** Etichetta di una sotto-voce: "20" -> "Line 20". Ora tutte le sotto-voci
   *  (incluse le Night lines) sono numeri di linea reali. */
  sublineLabel(sub: string): string {
    return `Line ${sub}`;
  }

  /**
   * True se una riga-GRUPPO della legenda va mostrata "sgrigiata" (.dimmed).
   * PATCH-LUCA "livery-legend-sublines-dim" (2026-07-29): la logica di dimming
   * deve valere ANCHE quando il filtro attivo e' per SINGOLA linea. Regole:
   *   - se c'e' un filtro per singola linea (selectedLiveryLines non vuoto):
   *     la riga-gruppo resta accesa SOLO se almeno una delle sue sotto-linee
   *     e' selezionata; altrimenti si sgrigia.
   *   - altrimenti si applica la logica per colore (isLiveryColorSelected).
   */
  isLegendGroupDimmed(g: { color: string; name: string }): boolean {
    // PATCH-LUCA "subline-uses-linekeys-2026-09-01": il filtro per singola linea
    // ora vive in selectedLiveryLineKeys (non piu' in selectedLiveryLines). Se
    // ci sono singole linee selezionate (senza un modo intero attivo per questa
    // riga), la riga-gruppo resta accesa solo se almeno una sua sotto-linea e' on.
    if (this.selectedLiveryLineKeys.size > 0) {
      // legendSubLines() ritorna i token linea sia per voci multiple che
      // singole (es. "Line 36" -> ['36']). La riga resta accesa se almeno una
      // delle sue linee e' selezionata.
      const tokens = this.legendSubLines(g.name);
      const anySelected = tokens.some((s) => this.isLiveryLineSelected(s));
      return !anySelected;
    }
    // PATCH-LUCA "lines-legend-by-mode-2026-09-01": se il filtro attivo e' per
    // MODO, una riga-colore resta accesa solo se il suo colore appartiene a un
    // modo selezionato (altrimenti si sgrigia).
    if (this.selectedLiveryModes.size > 0 && this.selectedLiveryColors.size === 0) {
      const norm = this.normalizeColor(g.color);
      const mc = this.modeColors();
      for (const mode of this.selectedLiveryModes) {
        if (mc[mode] && mc[mode].has(norm)) return false;
      }
      return true;
    }
    return !this.isLiveryColorSelected(g.color);
  }

  /**
   * Click su una SINGOLA sotto-linea della legenda (es. "Line 79").
   * In mappa resta SOLO quella linea (property 'line'). Toggle multi-selezione:
   *   - primo click su una sotto-linea -> filtro per singola linea attivo, in
   *     mappa solo quella;
   *   - click su un'altra sotto-linea -> si aggiunge;
   *   - ri-click su una selezionata -> si toglie; se era l'ultima, il layer si
   *     SPEGNE (coerente col comportamento livery-select-toggles-layer).
   * Se il layer e' spento, lo accende mostrando solo quella linea.
   */
  onSelectLiverySubLine(line: string, color: string, ev: Event): void {
    ev.stopPropagation();
    const ln = String(line).trim();
    if (!ln) return;

    // PATCH-LUCA "subline-uses-linekeys-2026-09-01" (richiesta Luca):
    // Cliccando una SINGOLA linea nella lista espansa, dev'essere selezionabile
    // INDIVIDUALMENTE e in modo COMBINABILE con i modi/righe gia' accesi.
    // Prima questo handler scriveva nel vecchio set 'selectedLiveryLines' (solo
    // il numero, senza modo) che pero' applyLiveryFilter NON guarda piu': il
    // filtro attivo lavora su 'selectedLiveryModes' + 'selectedLiveryLineKeys'
    // (chiave 'mode|line'). Percio' il click sulla singola linea non filtrava
    // nulla. Ora costruiamo la/e chiave/i 'mode|line' corretta/e e le
    // aggiungiamo/togliamo in selectedLiveryLineKeys, SENZA azzerare nulla.
    const norm = this.normalizeColor(color);

    // Ricavo il/i modo/i a cui appartiene questa (linea + colore). Di norma e'
    // uno solo, ma se lo stesso numero+colore esistesse in piu' modi li gestisco
    // tutti (data-driven dal geojson).
    const modes = this.modesForLineColor(ln, norm);
    // Fallback: se non trovo il modo (geojson non pronto), provo col solo numero
    // di linea, cosi' la selezione funziona comunque su tutti i modi che la usano.
    const keys = modes.length
      ? modes.map((m) => m + '|' + ln)
      : this.modesForLine(ln).map((m) => m + '|' + ln);
    if (!keys.length) return;

    const layerOff = !this.activeLayers.has('heatmap_lines_livery');
    if (layerOff) {
      // Layer spento -> lo accendo con SOLO questa linea selezionata.
      this.lineStyleMode = 'livery';
      const other = 'heatmap_lines_freq';
      if (this.activeLayers.has(other)) {
        this.activeLayers.delete(other);
        this.removeLayer(other);
        this.openLegends.delete(other);
      }
      this.selectedLiveryColors.clear();
      this.selectedLiveryModes.clear();
      this.selectedLiveryModeColors.clear();
      this.selectedLiveryLineKeys.clear();
      for (const k of keys) this.selectedLiveryLineKeys.add(k);
      const cfg = this.layers.find((x) => x.id === 'heatmap_lines_livery');
      if (cfg) {
        this.activeLayers.add('heatmap_lines_livery');
        this.loadLayer(cfg); // a fine fetch applica il filtro
      }
      return;
    }

    // Layer acceso: se il MODO intero e' acceso, cliccare una sua singola linea
    // lo "esplode" nelle singole linee tranne questa (che spengo), per coerenza
    // con onSelectLiveryGroupRow.
    for (const m of modes) {
      if (this.selectedLiveryModes.has(m)) {
        this.selectedLiveryModes.delete(m);
        for (const other of this.rowLinesForMode(m)) {
          const k = m + '|' + other;
          if (!keys.includes(k)) this.selectedLiveryLineKeys.add(k);
        }
      }
    }

    // Toggle della singola linea: se tutte le sue chiavi sono gia' accese -> le
    // spengo; altrimenti le accendo.
    const allOn = keys.every((k) => this.selectedLiveryLineKeys.has(k));
    if (allOn) {
      for (const k of keys) this.selectedLiveryLineKeys.delete(k);
    } else {
      for (const k of keys) this.selectedLiveryLineKeys.add(k);
    }

    this.finishLiverySelectionChange();
  }

  /** PATCH-LUCA "subline-uses-linekeys-2026-09-01": modi (bus/metro/tram) che
   *  usano un dato NUMERO di linea con un dato COLORE normalizzato. Data-driven. */
  private modesForLineColor(line: string, norm: string): string[] {
    const feats = this.liveryFeatures();
    const set = new Set<string>();
    for (const f of feats) {
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (ln !== line) continue;
      const c = this.normalizeColor(String(f?.properties?.['color'] ?? ''));
      if (c !== norm) continue;
      set.add(this.transitTypeToMode(f));
    }
    return Array.from(set);
  }

  /** PATCH-LUCA "subline-uses-linekeys-2026-09-01": modi che usano un dato NUMERO
   *  di linea (ignorando il colore). Fallback quando manca il match sul colore. */
  private modesForLine(line: string): string[] {
    const feats = this.liveryFeatures();
    const set = new Set<string>();
    for (const f of feats) {
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (ln !== line) continue;
      set.add(this.transitTypeToMode(f));
    }
    return Array.from(set);
  }


  /** True se una riga della legenda livery e' attualmente selezionata (accesa). */
  isLiveryColorSelected(color: string): boolean {
    // Set vuoto = tutte selezionate (nessun filtro attivo).
    if (this.selectedLiveryColors.size === 0) return true;
    return this.selectedLiveryColors.has(this.normalizeColor(color));
  }

  /** True se il filtro livery e' attivo (almeno una riga selezionata esplicitamente). */
  get liveryFilterActive(): boolean {
    return this.selectedLiveryColors.size > 0;
  }

  /**
   * Click su una riga colore della legenda livery: toggle multi-selezione.
   * stopPropagation per NON far scattare il reset (click sul vuoto).
   */
  onSelectLiveryColor(color: string, ev: Event): void {
    ev.stopPropagation();
    const norm = this.normalizeColor(color);
    // PATCH-LUCA "livery-legend-expand-sublines": selezionare un COLORE intero
    // azzera l'eventuale filtro per singola linea (i due filtri sono alternativi).
    this.selectedLiveryLines.clear();
    // PATCH-LUCA "lines-legend-by-mode-2026-09-01": azzero anche il filtro per modo.
    this.selectedLiveryModes.clear();
    this.selectedLiveryModeColors.clear();

    // PATCH-LUCA "livery-select-toggles-layer":
    // Comportamento richiesto quando si seleziona una linea dalla legenda
    // SENZA aver prima acceso il layer "Transport lines":
    //   - se il layer e' SPENTO e clicco una riga colore, il layer si ACCENDE
    //     automaticamente e in mappa compare SOLO quella linea (il pulsante si
    //     illumina);
    //   - deselezionando l'ultima linea rimasta, il layer si SPEGNE di nuovo
    //     (il pulsante si spegne);
    //   - riselezionando una linea, il layer si riaccende;
    //   - se poi si spegne e riaccende il layer dal suo pulsante, il
    //     comportamento torna quello NORMALE (tutte le linee accese), perche'
    //     onToggleLayer/loadLayer non hanno un filtro attivo.
    //
    // NB: quando il layer e' SPENTO, selectedLiveryColors e' vuoto ma questo
    // NON significa "tutte le linee" (il layer non e' in mappa): il primo
    // click deve quindi ACCENDERE il layer e selezionare SOLO quel colore,
    // non fare da "reset". Per questo gestisco a parte il caso layer spento.
    const layerOff = !this.activeLayers.has('heatmap_lines_livery');
    if (layerOff) {
      // Layer spento -> accendo il layer con SOLO questo colore selezionato.
      // Assicuro la modalita' di rendering "livery" (come fa onToggleLayer).
      this.lineStyleMode = 'livery';
      // Se e' acceso l'altro layer linee (Heatmap frequency), lo spengo per
      // mutua esclusivita', coerentemente con onToggleLayer.
      const other = 'heatmap_lines_freq';
      if (this.activeLayers.has(other)) {
        this.activeLayers.delete(other);
        this.removeLayer(other);
        this.openLegends.delete(other);
      }
      this.selectedLiveryColors.clear();
      this.selectedLiveryColors.add(norm);
      const cfg = this.layers.find((x) => x.id === 'heatmap_lines_livery');
      if (cfg) {
        this.activeLayers.add('heatmap_lines_livery');
        // loadLayer, a fine fetch, richiama applyLiveryFilter se il filtro e'
        // attivo -> in mappa comparira' solo la linea selezionata.
        this.loadLayer(cfg);
      }
      return;
    }

    // Layer gia' acceso: toggle multi-selezione come prima.
    if (this.selectedLiveryColors.has(norm)) {
      // gia' selezionata -> la deseleziono
      this.selectedLiveryColors.delete(norm);
    } else {
      this.selectedLiveryColors.add(norm);
    }

    // PATCH-LUCA "livery-select-toggles-layer": se dopo la deselezione NON
    // resta piu' alcuna linea selezionata (ma prima ce n'era almeno una, cioe'
    // ho appena tolto l'ultima), SPENGO il layer (il pulsante si spegne),
    // invece di ricadere nello stato "nessun filtro = tutte visibili".
    // PATCH-LUCA "empty-selection-shows-all-2026-09-01" (richiesta Luca): se non
    // resta piu' nulla selezionato, NON spengo il layer: lo lascio acceso e
    // mostro TUTTE le linee (filtro azzerato). Legenda aperta, righe accese.
    if (this.selectedLiveryColors.size === 0) {
      this.applyLiveryFilter();
      return;
    }

    this.applyLiveryFilter();
  }

  /**
   * Click su un punto VUOTO della legenda livery (non su una riga): reset,
   * tutte le linee tornano visibili.
   */
  onResetLiveryFilter(): void {
    // PATCH-LUCA "livery-legend-expand-sublines": il reset azzera SIA il filtro
    // per colore SIA quello per singola linea.
    // PATCH-LUCA "lines-legend-by-mode-2026-09-01": azzera anche il filtro per modo.
    if (this.selectedLiveryColors.size === 0 && this.selectedLiveryLines.size === 0 && this.selectedLiveryModes.size === 0 && this.selectedLiveryModeColors.size === 0) return;
    this.selectedLiveryColors.clear();
    this.selectedLiveryLines.clear();
    this.selectedLiveryModes.clear();
    this.selectedLiveryModeColors.clear();
    this.applyLiveryFilter();
  }

  /**
   * Applica il filtro alla mappa: mostra/nasconde ogni sotto-layer della linea
   * in base al fatto che il suo colore sia tra quelli selezionati. Con Set
   * vuoto tutte le linee sono visibili. Agisce sul layer livery in cache
   * (chiave 'heatmap_lines_livery').
   */
  /** PATCH-LUCA "combinable-mode-and-line-2026-09-01" (richiesta Luca): chiave
   *  UNIVOCA di una LINEA (modo + numero linea), es. 'tram|ML2', 'metro|9',
   *  'bus|40'. Usata per selezionare SINGOLE linee in modo combinabile con la
   *  selezione di interi MODI. Data-driven: vale per qualsiasi citta'. */
  private lineKeyOf(f: any): string {
    const mode = this.transitTypeToMode(f);
    const ln = String(f?.properties?.['line'] ?? '').trim();
    return mode + '|' + ln;
  }

  private modeColorKeyOf(f: any): string {
    const mode = this.transitTypeToMode(f);
    const norm = this.normalizeColor(String(f?.properties?.['color'] ?? '#53006c'));
    return mode + '|' + norm;
  }

  private applyLiveryFilter(): void {
    const layer = this.layerCache.get('heatmap_lines_livery');
    if (!layer) return;
    // PATCH-LUCA "combinable-mode-and-line-2026-09-01" (richiesta Luca):
    // I due tipi di selezione ora si COMBINANO (OR), non si escludono:
    //   - selectedLiveryModes    = MODI interi accesi (bus/metro/tram)
    //   - selectedLiveryLineKeys = SINGOLE linee accese, chiave 'mode|line'
    // Una feature e' visibile se il suo MODO e' selezionato OPPURE la sua LINEA
    // specifica e' selezionata. Cosi' si puo' accendere tutto il Tram + solo la
    // metro 9 + solo il bus 40, tutti insieme.
    // Se NESSUNA selezione (entrambi vuoti) -> tutte le linee visibili.
    const anySel = this.selectedLiveryModes.size > 0 || this.selectedLiveryLineKeys.size > 0;
    layer.eachLayer((sub: any) => {
      let visible: boolean;
      if (!anySel) {
        visible = true; // nessun filtro
      } else {
        const modeOfFeat = this.transitTypeToMode(sub.feature);
        const lineKey = this.lineKeyOf(sub.feature);
        visible = this.selectedLiveryModes.has(modeOfFeat) || this.selectedLiveryLineKeys.has(lineKey);
      }
      if (typeof sub.setStyle === 'function') {
        // opacity 0 = tratto invisibile (ma resta nel layer, cosi' il toggle
        // successivo lo puo' rimostrare senza ricaricare il geojson).
        sub.setStyle(visible
          ? { opacity: 0.85 }
          : { opacity: 0 });
      }
    });
  }

  // ============================================================
  // PATCH-LUCA "livery-click-all-lines" (2026-07-28, richiesta Luca):
  // Cliccando un PUNTO sulla mappa nel layer "Transport lines" (livery), l'utente
  // vuole vedere TUTTE le linee che passano in quel punto (non solo la singola
  // feature che Leaflet intercetta col click). Quindi:
  //   - al click sul layer, scandisco TUTTE le feature del layer livery e
  //     raccolgo quelle la cui geometria passa ENTRO una piccola tolleranza in
  //     pixel dal punto cliccato;
  //   - per ognuna prendo { line, name, color } (nome + livrea);
  //   - dedup e ordino ALFABETICAMENTE per nome;
  //   - apro UN SOLO popup con l'elenco: ogni linea su una riga con il pallino
  //     del suo colore livrea + il nome.
  // Se sotto al click c'e' una sola linea, il popup elenca solo quella.
  // ============================================================

  /** Tolleranza in PIXEL per considerare una linea "sotto" al punto cliccato. */
  private readonly LIVERY_CLICK_TOL_PX = 8;

  /**
   * Distanza (in pixel schermo) tra un punto cliccato (LatLng) e il segmento
   * geometrico p1-p2 (entrambi LatLng), proiettati sui pixel della mappa.
   */
  private distToSegmentPx(click: L.LatLng, a: L.LatLng, b: L.LatLng): number {
    const cp = this.map.latLngToLayerPoint(click);
    const ap = this.map.latLngToLayerPoint(a);
    const bp = this.map.latLngToLayerPoint(b);
    const dx = bp.x - ap.x, dy = bp.y - ap.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((cp.x - ap.x) * dx + (cp.y - ap.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projx = ap.x + t * dx, projy = ap.y + t * dy;
    const ex = cp.x - projx, ey = cp.y - projy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /** True se la geometria (LineString/MultiLineString) passa entro tolPx dal click. */
  private geometryNearClick(geom: any, click: L.LatLng, tolPx: number): boolean {
    if (!geom) return false;
    const scanLine = (coords: number[][]): boolean => {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = L.latLng(coords[i][1], coords[i][0]);
        const b = L.latLng(coords[i + 1][1], coords[i + 1][0]);
        if (this.distToSegmentPx(click, a, b) <= tolPx) return true;
      }
      return false;
    };
    if (geom.type === 'LineString') return scanLine(geom.coordinates);
    if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) { if (scanLine(line)) return true; }
    }
    return false;
  }

  /**
   * Handler del click sul layer "Transport lines" (livery). Raccoglie le
   * SINGOLE LINEE (numero reale del campo 'line') che passano nel punto
   * cliccato (entro tolleranza) e le mostra in un popup unico, UNA riga per
   * linea: "Line <numero>" + il colore livrea di quella linea.
   * PATCH-LUCA "livery-click-real-line-number" (2026-07-28, richiesta Luca):
   *   NON mostro piu' l'etichetta di gruppo della legenda ("Lines 5a, 5b, R80")
   *   ma il numero REALE della linea che passa lì (es. solo "Line 5a" se passa
   *   solo la 5a; "Line 5a" + "Line 5b" se passano entrambe).
   * ORDINE: seguo l'ordine della legenda livery -> ordino prima per posizione
   *   del COLORE della linea nella LINE_LEGEND, poi per numero di linea.
   * Rispetta il filtro legenda (se attivo, solo le linee dei colori selezionati).
   */
  private onLiveryMapClick(ev: any): void {
    const layer = this.layerCache.get('heatmap_lines_livery');
    if (!layer || !ev || !ev.latlng) return;
    const click = ev.latlng as L.LatLng;
    const noFilter = this.selectedLiveryColors.size === 0;

    // Indice colore-normalizzato -> posizione nella legenda (per l'ordinamento).
    const legendOrder = new Map<string, number>();
    this.LINE_LEGEND.forEach((it, i) => {
      const c = this.normalizeColor(it.color);
      if (!legendOrder.has(c)) legendOrder.set(c, i);
    });

    // Raccolgo le SINGOLE linee (numero 'line') vicine al click, dedup per
    // numero+colore, con il colore livrea di ciascuna.
    // PATCH-LUCA "livery-popup-show-terminus" (richiesta Luca): raccolgo anche
    // il/i CAPOLINEA (property 'destination') di ogni linea, per mostrarlo nel
    // popup accanto al numero della linea ("Line 43 -> Cibeles"). Una stessa
    // linea ha spesso 2 destinazioni (andata/ritorno): le accumulo entrambe
    // (distinte) e nel popup le mostro separate da " / ".
    const byLine = new Map<string, { line: string; color: string; destinations: string[] }>();
    layer.eachLayer((sub: any) => {
      const f = sub.feature;
      const geom = f?.geometry;
      if (!geom) return;
      const col = this.normalizeColor(String(f.properties?.['color'] ?? '#53006c'));
      // rispetto il filtro legenda: se attivo, ignoro le linee non selezionate
      if (!noFilter && !this.selectedLiveryColors.has(col)) return;
      if (!this.geometryNearClick(geom, click, this.LIVERY_CLICK_TOL_PX)) return;
      const ln = String(f.properties?.['line'] ?? '').trim();
      if (!ln) return;
      const dest = String(f.properties?.['destination'] ?? '').trim();
      const key = ln + '|' + col;
      if (!byLine.has(key)) {
        byLine.set(key, { line: ln, color: col, destinations: dest ? [dest] : [] });
      } else if (dest) {
        const cur = byLine.get(key)!;
        if (cur.destinations.indexOf(dest) === -1) cur.destinations.push(dest);
      }
    });
    if (!byLine.size) return; // click nel vuoto: nessun popup

    // PATCH-LUCA "livery-click-R-lines-last" (2026-07-29, richiesta Luca):
    // Ordino le linee nel popup cosi':
    //   1) prima le linee NUMERICHE (che NON iniziano per R: 1, 5a, 5b, 10,
    //      11, 40, 537, ...) in ordine di numero CRESCENTE (in cima la piu'
    //      bassa);
    //   2) poi le linee con la R (R80, R81, R92, ...) IN FONDO, anch'esse
    //      ordinate tra loro per numero crescente.
    // NON si segue piu' l'ordine dei colori della legenda: conta solo il
    // numero di linea, con le "R" sempre relegate in coda.
    //
    // FIX "livery-click-numeric-sort" (2026-07-29): localeCompare(numeric)
    // NON ordinava correttamente etichette come "5a", "40", "537" (finivano
    // 537/557 prima di 5a/40). Ora estraggo ESPLICITAMENTE la parte numerica
    // (parseInt) e la confronto come NUMERO vero; il suffisso alfabetico
    // (es. la 'a'/'b' di 4a/5b) e' usato solo come tie-breaker a parita' di
    // numero. Cosi' l'ordine e' 1,3,4a,4b,5a,5b,40,41,...,537,557,... e le R
    // in fondo.
    const isRLine = (ln: string) => /^r/i.test(ln.trim());
    // parte numerica di una linea (ignora eventuale R iniziale): "R92"->92,
    // "5a"->5, "537"->537, "40"->40. Se non trova cifre -> Infinity (in coda).
    const lineNum = (ln: string) => {
      const m = ln.trim().replace(/^r/i, '').match(/\d+/);
      return m ? parseInt(m[0], 10) : Number.POSITIVE_INFINITY;
    };
    // suffisso alfabetico dopo il numero (per distinguere 5a da 5b): "5a"->"a".
    const lineSuffix = (ln: string) => {
      const m = ln.trim().replace(/^r/i, '').match(/\d+([a-z].*)$/i);
      return m ? m[1].toLowerCase() : '';
    };
    const lines = Array.from(byLine.values()).sort((a, b) => {
      const ar = isRLine(a.line) ? 1 : 0;
      const br = isRLine(b.line) ? 1 : 0;
      // gruppo diverso (numerica vs R): le numeriche (0) prima, le R (1) dopo
      if (ar !== br) return ar - br;
      // stesso gruppo: ordino per VALORE numerico reale
      const na = lineNum(a.line), nb = lineNum(b.line);
      if (na !== nb) return na - nb;
      // stesso numero: uso il suffisso (5a < 5b), poi la stringa intera
      const sa = lineSuffix(a.line), sb = lineSuffix(b.line);
      if (sa !== sb) return sa.localeCompare(sb);
      return a.line.localeCompare(b.line, undefined, { sensitivity: 'base' });
    });

    const html = this.buildLiveryLinesPopupHtml(lines);
    L.popup({ className: 'lz-popup', maxWidth: 300 })
      .setLatLng(click)
      .setContent(html)
      .openOn(this.map);
  }

  /**
   * PATCH-LUCA "livery-popup-line-url-from-stopinfo-2026-11-09" (richiesta Luca):
   * URL della linea IDENTICO a quello usato dal PANNELLO FERMATA. Le fermate
   * mostrano "linea N" come link usando il campo url della line_list letta da
   * stop_info.json (route_url del feed GTFS). Qui costruisco una mappa
   * lineNumber -> url scandendo TUTTE le line_list di stopInfo, cosi' il popup
   * del TRACCIATO usa lo STESSO identico link delle fermate. Cache per non
   * riscandire ad ogni popup. Ritorna '' se la linea non ha url nel feed.
   */
  private lineUrlMapCache: { [line: string]: string } | null = null;
  private urlForLine(line: string): string {
    const ln = String(line ?? '').trim();
    if (!ln) return '';
    if (!this.lineUrlMapCache) {
      const map: { [line: string]: string } = {};
      const info = this.stopInfo || {};
      for (const id of Object.keys(info)) {
        const ll = info[id]?.line_list;
        if (!Array.isArray(ll)) continue;
        for (const it of ll) {
          const key = String(it?.line ?? '').trim();
          const url = String(it?.url ?? '').trim();
          if (key && url && !map[key]) map[key] = url;
        }
      }
      this.lineUrlMapCache = map;
    }
    return this.lineUrlMapCache[ln] || '';
  }

  /** HTML del popup multi-linea: una riga per SINGOLA linea (campione colore
   *  livrea + "Line <numero>" + capolinea), nell'ordine della legenda livery.
   *  PATCH-LUCA "livery-popup-show-terminus" (richiesta Luca): accanto ad ogni
   *  linea mostro il/i CAPOLINEA (destinations) di quella linea, es.
   *  "Line 43  ->  Cibeles" oppure "Line 1  ->  Prosperidad / Cristo Rey"
   *  quando passano entrambe le direzioni. Se la destination manca, mostro
   *  solo il numero. */
  private buildLiveryLinesPopupHtml(lines: { line: string; color: string; destinations?: string[] }[]): string {
    const esc = (v: any) =>
      v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = lines.map((ln) => {
      const col = this.normalizeColor(ln.color);
      // PATCH-LUCA "livery-popup-line-swatch" (richiesta Luca): al posto del
      // pallino tondo, un CAMPIONE A FORMA DI LINEA (barretta orizzontale) dello
      // stesso colore della linea in mappa, cosi' l'utente riconosce subito la
      // livrea. Il bianco (Night lines) resta visibile grazie al bordo grigio.
      const lineSwatch = `<span style="width:22px;height:4px;border-radius:2px;flex:0 0 auto;background:${col};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.35),0 1px 2px rgba(0,0,0,.15)"></span>`;
      // PATCH-LUCA "livery-popup-show-terminus": capolinea accanto al numero.
      // Freccia + destinazione/i (piu' direzioni separate da " / ") in grigio;
      // se manca la destination non mostro nulla.
      const dest = (ln.destinations || []).filter((d) => !!d && d.trim()).join(' / ');
      const destHtml = dest
        ? `<span style="color:#6b7280;flex:0 0 auto">&#8594;</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4b5563">${esc(dest)}</span>`
        : '';
      // PATCH-LUCA "livery-popup-line-link-like-stop-2026-11-09" (richiesta Luca):
      // il numero "Line N" nel popup del TRACCIATO e' reso IDENTICO al link
      // "linea N" del pannello fermata: NON sottolineato di default, e all'HOVER
      // si colora di viola (#7a1fa2) e si sottolinea. Lo stile e' nella classe
      // globale .lz-line-link (CSS, copiata pari pari da .si-line-link), quindi
      // qui NON metto text-decoration inline. Uso l'url reale della linea
      // (route_url del feed GTFS) via urlForLine(): se manca, resta testo semplice.
      const lineUrl = this.urlForLine(ln.line);
      const lineLabel = lineUrl
        ? `<a href="${esc(lineUrl)}" target="_blank" rel="noopener noreferrer" class="lz-line-link">Line ${esc(ln.line)}</a>`
        : `<span style="white-space:nowrap;flex:0 0 auto;font-weight:600">Line ${esc(ln.line)}</span>`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12.5px;color:#1f2937">
                ${lineSwatch}${lineLabel}${destHtml}
              </div>`;
    }).join('');
    return `
      <div class="lzp" style="font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;min-width:170px;max-width:300px">
        <div style="font-weight:700;color:#111827;letter-spacing:.2px;margin-bottom:6px">
          Lines here (${lines.length})
        </div>
        ${rows}
      </div>`;
  }


  // ============================================================
  // PATCH-LUCA "freq-shape-select" (2026-07-28, richiesta Luca):
  // Cliccando una shape (tratto) sulla mappa in modalita' "Heatmap frequency"
  // (lineStyleMode 'qml', layer heatmap_lines_freq):
  //   - in mappa TUTTE le altre shapes si SGRIGIANO (opacity abbassata a 0.12),
  //     resta colorata a piena opacita' SOLO la shape cliccata (evidenziata
  //     anche con weight maggiore);
  //   - si apre un INFO-BOX in alto a sinistra con i dati della shape:
  //       * frequency (numero di trip GTFS su quel tracciato),
  //       * linea, destinazione, direzione, fascia oraria, lunghezza,
  //       * e l'ELENCO di TUTTE le linee che passano su quel corridoio
  //         (linee le cui shapes condividono un tratto significativo con
  //          quella cliccata: match per vertici in comune).
  //   - Ri-cliccando la stessa shape, o cliccando l'info-box "chiudi", o
  //     cliccando su un punto vuoto della mappa, si RESETTA (tutte le shapes
  //     tornano piene, info-box chiuso).
  // Stato:
  //   freqSelectedShapeId = shape_id della shape selezionata ('' = nessuna).
  //   freqInfo            = oggetto con i dati mostrati nell'info-box.
  // ============================================================
  freqSelectedShapeId = '';
  freqInfo: {
    shapeId: string;
    shapeName: string;
    line: string; destination: string; direction: string;
    period: string; frequency: string; lengthKm: string;
    // PATCH-LUCA "freq-num-line-color" (richiesta Luca): colore della shape in
    // mappa (heatmap frequency), usato per colorare il numero delle corse
    // nell'info-box con lo STESSO colore della linea sulla mappa.
    freqColor: string;
    passingLines: { line: string; name: string; color: string }[];
  } | null = null;

  /**
   * Click su una shape del layer "Heatmap frequency". Seleziona quella shape:
   * sgrigia le altre in mappa e popola l'info-box. Se ri-clicco la stessa
   * shape gia' selezionata, deseleziono (reset).
   */
  onSelectFreqShape(feature: any, ev?: any): void {
    if (ev && ev.originalEvent) {
      try { L.DomEvent.stopPropagation(ev); } catch (e) {}
    }
    const p = feature?.properties || {};
    // PATCH-LUCA "freq-heatmap-strade": la nuova heatmap identifica gli archi
    // stradali con 'arco_id' (non piu' 'shape_id').
    const sid = String(p['arco_id'] ?? '');
    if (!sid) return;

    // toggle: ri-click sullo stesso arco -> reset
    if (this.freqSelectedShapeId === sid) {
      this.resetFreqSelection();
      return;
    }

    this.freqSelectedShapeId = sid;
    this.freqInfo = this.buildFreqInfo(feature);
    this.applyFreqDim();
    this.cdr.detectChanges();
  }

  /** Reset della selezione frequency: tutte le shapes tornano piene, box chiuso. */
  resetFreqSelection(): void {
    if (!this.freqSelectedShapeId && !this.freqInfo) return;
    this.freqSelectedShapeId = '';
    this.freqInfo = null;
    this.applyFreqDim();
    this.cdr.detectChanges();
  }

  /**
   * Applica lo stile di "dimming" al layer heatmap_lines_freq in cache:
   * - nessuna selezione -> tutte le shapes con lo stile pieno (styleForLine);
   * - selezione attiva  -> la shape selezionata piena+evidenziata (weight 4),
   *   tutte le altre COMPLETAMENTE NASCOSTE (opacity 0). PATCH-LUCA
   *   "freq-others-hidden" (2026-07-28): su richiesta utente le altre shapes
   *   NON vengono piu' solo sgrigiate ma spariscono del tutto (opacity 0).
   */
  private applyFreqDim(): void {
    const layer = this.layerCache.get('heatmap_lines_freq');
    if (!layer) return;
    const sel = this.freqSelectedShapeId;
    layer.eachLayer((sub: any) => {
      if (typeof sub.setStyle !== 'function') return;
      const sid = String(sub.feature?.properties?.['arco_id'] ?? '');
      if (!sel) {
        // reset: ristabilisco lo stile pieno per frequenza
        sub.setStyle(this.styleForLine(sub.feature));
      } else if (sid === sel) {
        // shape selezionata: piena + evidenziata
        const base = this.styleForLine(sub.feature);
        sub.setStyle({ ...base, opacity: 1, weight: 4 });
        try { if (typeof sub.bringToFront === 'function') sub.bringToFront(); } catch (e) {}
      } else {
        // altre shapes: NASCOSTE del tutto (opacity 0 = invisibili, ma restano
        // nel layer cosi' il reset le rimostra senza ricaricare il geojson).
        sub.setStyle({ opacity: 0 });
      }
    });
    // PATCH-LUCA "freq-zorder-by-frequency": dopo un reset (nessuna selezione)
    // ripristino l'ordine z per frequenza, cosi' le shape piu' trafficate
    // restano SEMPRE in cima.
    if (!sel) this.applyFreqZOrder();
  }

  /**
   * PATCH-LUCA "freq-zorder-by-frequency" (2026-07-28, richiesta Luca):
   * Ordina lo z-order delle shape del layer "Heatmap frequency" in base al
   * campo 'frequency': le shape PIU' TRAFFICATE (frequency alta) vengono
   * portate SOPRA (in cima), quelle meno trafficate restano SOTTO. Cosi' i
   * corridoi ad alta frequenza non vengono mai coperti da quelli a bassa
   * frequenza quando i tracciati si sovrappongono.
   *
   * TECNICA (Leaflet): l'ordine di disegno dentro un pane dipende dall'ordine
   * degli elementi nel DOM SVG. bringToFront() sposta un path in fondo al DOM
   * (= disegnato per ULTIMO = sopra tutti). Quindi itero le shape ordinate per
   * frequency CRESCENTE e chiamo bringToFront() su ciascuna: l'ultima portata
   * avanti (freq piu' alta) resta davanti a tutte.
   */
  private applyFreqZOrder(): void {
    const layer = this.layerCache.get('heatmap_lines_freq');
    if (!layer) return;
    const subs: any[] = [];
    layer.eachLayer((sub: any) => {
      if (typeof sub.bringToFront === 'function') subs.push(sub);
    });
    const freqOf = (sub: any): number => {
      // PATCH-LUCA "freq-heatmap-strade": z-order per freq_giornaliera dell'arco.
      const raw = sub?.feature?.properties?.['freq_giornaliera'];
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return isNaN(n) ? 0 : n;
    };
    // ordine crescente per frequency: portando avanti dal meno al piu' trafficato,
    // le shape ad alta frequenza finiscono in cima.
    subs.sort((a, b) => freqOf(a) - freqOf(b));
    for (const sub of subs) {
      try { sub.bringToFront(); } catch (e) {}
    }
  }

  /**
   * Costruisce i dati dell'info-box per una shape del layer frequency.
   * PATCH-LUCA "freq-info-by-shapeid" (2026-07-28, richiesta Luca):
   *   - shapeId  = shape_id della shape cliccata (mostrato come TITOLO dell'info-box).
   *   - passingLines = SOLO le linee che condividono ESATTAMENTE la stessa
   *     shape_id (cioe' lo stesso identico tracciato), NON piu' tutte le linee
   *     del corridoio geografico. Nel geojson una stessa shape_id puo' essere
   *     usata da piu' feature/linee: raccolgo i loro 'line'.
   */
  /**
   * Costruisce i dati dell'info-box per un ARCO del layer "Heatmap frequency".
   * PATCH-LUCA "freq-heatmap-strade" (richiesta Luca): la nuova heatmap e'
   * calcolata sugli ARCHI STRADALI OSM (assets/heatmap_freq_strade.geojson).
   * L'info-box mostra:
   *   - shapeName  = nome della strada (campo 'name'); fallback su highway o "Road segment";
   *   - shapeId    = arco_id (mostrato piccolo come riferimento);
   *   - frequency  = FREQUENZA ORARIA (campo 'freq_oraria' = corse/ora), gia'
   *                  precalcolata come freq_giornaliera / 18h di servizio;
   *   - freqColor  = colore dell'arco in mappa (campo 'colore', palette YlOrRd);
   *   - lengthKm   = non disponibile per gli archi stradali -> "—".
   * NIENTE elenco linee (passingLines resta vuoto, richiesta esplicita utente).
   */
  private buildFreqInfo(feature: any): {
    shapeId: string;
    shapeName: string;
    line: string; destination: string; direction: string;
    period: string; frequency: string; lengthKm: string;
    freqColor: string;
    passingLines: { line: string; name: string; color: string }[];
  } {
    const p = feature?.properties || {};

    const arcoId = String(p['arco_id'] ?? '—');
    const nameRaw = String(p['name'] ?? '').trim();
    const highway = String(p['highway'] ?? '').trim();
    const shapeName = nameRaw || (highway ? this.prettyHighway(highway) : 'Road segment');

    // Frequenza ORARIA (corse/ora): arrotondo a 1 decimale per la UI.
    const hourlyRaw = parseFloat(p['freq_oraria']);
    const hourly = isNaN(hourlyRaw) ? null : hourlyRaw;
    const frequency = hourly == null ? '—' : hourly.toFixed(1);

    // Colore dell'arco in mappa (palette YlOrRd tematizzata in QGIS).
    const rawCol = String(p['colore'] ?? '').trim();
    const freqColor = rawCol ? this.normalizeColor(rawCol)
                             : this.colorForFrequency(p['freq_giornaliera']);

    return {
      shapeId: arcoId,
      shapeName,
      line: '—',
      destination: '—',
      direction: '—',
      period: '—',
      frequency,
      freqColor,
      lengthKm: '—',
      passingLines: [],
    };
  }

  /** Trasforma un valore OSM 'highway' (es. 'tertiary') in un'etichetta leggibile. */
  private prettyHighway(h: string): string {
    const s = h.replace(/_/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Road segment';
  }

  /** Raccoglie i vertici (chiavi "lon,lat" arrotondate a 4 decimali) di una geometria. */
  private collectCoordKeys(geom: any, out: Set<string>): void {
    if (!geom) return;
    const add = (coords: number[][]) => {
      for (const c of coords) out.add(c[0].toFixed(4) + ',' + c[1].toFixed(4));
    };
    if (geom.type === 'LineString') { add(geom.coordinates); }
    else if (geom.type === 'MultiLineString') { for (const line of geom.coordinates) add(line); }
  }


  // PATCH-LUCA "lines-legend-real":
  // La legenda "livery" ora mostra i NUMERI DI LINEA REALI di De Lijn per ogni
  // colore, come letti dal geojson (property 'line'). Nessuna etichetta
  // geografica inventata: ogni riga elenca esattamente quali linee usano
  // quel colore.
  // Ordinamento per numero di segmenti nel dataset (piu' presenti in alto).
  // Il bianco (#FFFFFF, 84 segmenti) corrisponde ai servizi notturni della
  // serie 400/500/600 e viene mostrato bianco sia in mappa sia in legenda
  // (il campione bianco e' reso visibile dal bordo grigio del .line-swatch).
  // PATCH-LUCA "legend-sort-by-line-number" (2026-07-28, richiesta Luca):
  // La legenda livery e' ora ordinata per NUMERO DI LINEA crescente (non piu'
  // per numero di segmenti). Regole applicate:
  //   1) Dentro ogni etichetta con piu' linee, i numeri sono in ordine
  //      crescente -> "Lines 40, 2" e' diventata "Lines 2, 40".
  //   2) Le righe sono ordinate sul PRIMO numero dell'etichetta (1,2,3,4a,5a,
  //      10,11,12,16,20,21,35,36,41,42,60,70...). Ordinamento NUMERICO, non
  //      alfabetico (Line 3 prima di Line 10).
  //   3) Le voci "R" da sole (Line R81) vanno tra le ultime "Line", subito
  //      prima delle Night lines.
  //   4) "Night lines" (bianco #FFFFFF, che aggrega le serie 400/500/600)
  //      resta in FONDO.
  // PATCH-LUCA "legend-data-driven-multicity" (richiesta Luca 2026-08-06):
  // LINE_LEGEND NON e' piu' un array HARDCODED (era cablato sulle 19 livree
  // De Lijn di Leuven, per cui portando i dati di un'altra citta' -- es. Madrid
  // -- la legenda restava di Leuven). Ora e' CALCOLATA A RUNTIME dal geojson
  // delle linee caricato (dataCache['lines'] / layer livery in cache),
  // raggruppando le feature per COLORE (property 'color') esattamente come
  // Leuven, cosi' la legenda si adatta AUTOMATICAMENTE a qualsiasi citta'.
  //
  // Regole di costruzione (identiche al comportamento Leuven richiesto):
  //   - una RIGA per ogni COLORE distinto del dataset;
  //   - l'etichetta elenca i numeri di linea (property 'line') che usano quel
  //     colore: "Line X" se una sola, "Lines X, Y, Z" se piu' di una (ordinati
  //     per numero crescente, le "R.." in coda);
  //   - la riga #FFFFFF (bianco) = "Night lines" e viene messa IN FONDO (il suo
  //     colore assegnato nel dataset resta il bianco, come chiesto);
  //   - le righe sono ordinate per NUMERO DI LINEA crescente (primo numero
  //     dell'etichetta), numerico non alfabetico; i colori con sole linee "R"
  //     vanno tra le ultime, subito prima delle Night.
  //
  // Il risultato e' messo in cache (lineLegendCache) e invalidato quando il
  // dataset delle linee cambia (invalidateLineLegend, chiamata a fine load).
  // NB: essendo un GETTER, l'HTML (*ngFor let g of LINE_LEGEND) e tutta la
  // logica esistente (espansione sotto-linee, filtro per colore/linea, popup)
  // continuano a funzionare INVARIATI, ora in modo data-driven.
  private lineLegendCache: { color: string; name: string }[] | null = null;

  /** Invalida la cache della legenda livery (dopo (ri)caricamento di line.geojson,
   *  o cambio citta'). Azzera anche nightLinesCache che dipende dallo stesso dataset. */
  private invalidateLineLegend(): void {
    this.lineLegendCache = null;
    this.nightLinesCache = null;
    // PATCH-LUCA "lines-legend-by-mode-2026-09-01": invalido anche le cache
    // del raggruppamento per modo, che dipendono dallo stesso dataset.
    this.lineLegendGroupsCache = null;
    this.modeColorsCache = null;
  }

  /** Estrae la parte numerica di un numero-linea (ignora una eventuale 'R'
   *  iniziale): "R92"->92, "5a"->5, "537"->537, "40"->40. Se non trova cifre
   *  ritorna Infinity (finisce in coda all'ordinamento). */
  private lineNumeric(ln: string): number {
    const m = String(ln).trim().replace(/^r/i, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : Number.POSITIVE_INFINITY;
  }

  /** Confronto tra due numeri-linea: prima per valore numerico reale, poi per
   *  suffisso alfabetico (5a < 5b), infine per stringa. Le "R.." NON sono
   *  spostate in coda qui (lo fa il chiamante dove serve): questo confronto e'
   *  usato per ordinare i token DENTRO una stessa etichetta multi-linea. */
  /** PATCH-LUCA "natural-sort-lines-2026-09-04" (richiesta Luca): ORDINAMENTO
   *  NATURALE (natural sort) dei codici linea, come in Python con re.split.
   *  Spezza ogni codice in parti alternate testo/numero e le confronta:
   *   - i gruppi di CIFRE come NUMERI veri (2 < 10 < 100), non come stringhe;
   *   - i gruppi di TESTO alfabeticamente (case-insensitive).
   *  Cosi' "N2" < "N10" < "N100", "172" < "172SF", ecc.
   *  ORDINE DEI GRUPPI: le linee PURAMENTE NUMERICHE (1,2,3,...,310) vengono
   *  PRIMA, poi le famiglie con prefisso alfabetico (A, BR1, C1, E1..., N1...N32,
   *  SE702..., T11...) raggruppate per prefisso e ordinate per numero interno.
   *  Ottenuto dando peso 0 ai segmenti numerici e peso 1 a quelli di testo
   *  (chi inizia con una cifra viene prima di chi inizia con una lettera).
   *  Vale per qualsiasi citta' (data-driven).
   */
  private naturalKey(s: string): Array<[number, number, string]> {
    // Spezza in parti alternate testo/numero (equivalente a re.split(/(\d+)/)).
    const parts = String(s).trim().split(/(\d+)/).filter((p) => p !== '');
    return parts.map((p) =>
      /^\d+$/.test(p)
        ? ([0, parseInt(p, 10), ''] as [number, number, string])   // NUMERO (peso 0 = prima)
        : ([1, 0, p.toLowerCase()] as [number, number, string]),    // TESTO  (peso 1 = dopo)
    );
  }

  private compareLineTokens(a: string, b: string): number {
    const ka = this.naturalKey(a);
    const kb = this.naturalKey(b);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
      const [ta, na, sa] = ka[i];
      const [tb, nb, sb] = kb[i];
      if (ta !== tb) return ta - tb;             // numero (0) prima di testo (1)
      if (ta === 0 && na !== nb) return na - nb;  // confronto numerico
      if (ta === 1 && sa !== sb) return sa < sb ? -1 : 1; // confronto testo
    }
    return ka.length - kb.length;                 // il piu' corto prima (es. "1" < "1a")
  }

  /** Costruisce la legenda livery data-driven dal geojson delle linee caricato.
   *  Ritorna [] se il dataset non e' ancora disponibile (fallback graceful:
   *  in tal caso la legenda comparira' appena i dati sono pronti). */
  private buildLineLegend(): { color: string; name: string }[] {
    // Sorgente dati: prima dataCache['lines'] (precaricato per i grafici); se
    // non ancora pronto, provo a ricavare le feature dal layer livery in cache.
    let feats: any[] = [];
    const gj = this.dataCache['lines'];
    if (gj && Array.isArray(gj.features)) {
      feats = gj.features;
    } else {
      const layer = this.layerCache.get('heatmap_lines_livery');
      if (layer) {
        const acc: any[] = [];
        layer.eachLayer((sub: any) => { if (sub.feature) acc.push(sub.feature); });
        feats = acc;
      }
    }
    if (!feats.length) return [];

    // Raggruppo i numeri di linea distinti per colore normalizzato.
    // colorByNorm: colore normalizzato -> colore "originale" da mostrare nello
    // swatch (uso la prima occorrenza cosi' rispetto la forma del dataset).
    const linesByColor = new Map<string, Set<string>>();
    const colorByNorm = new Map<string, string>();
    for (const f of feats) {
      const rawCol = String(f?.properties?.['color'] ?? '').trim();
      if (!rawCol) continue;
      const norm = this.normalizeColor(rawCol);
      if (!colorByNorm.has(norm)) colorByNorm.set(norm, rawCol);
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (!ln) continue;
      if (!linesByColor.has(norm)) linesByColor.set(norm, new Set<string>());
      linesByColor.get(norm)!.add(ln);
    }
    if (!linesByColor.size) return [];

    // Costruisco una voce per colore. Il bianco (#ffffff) diventa "Night lines".
    type Row = { color: string; name: string; isNight: boolean; firstNum: number; onlyR: boolean };
    const rows: Row[] = [];
    for (const [norm, set] of linesByColor) {
      const displayColor = colorByNorm.get(norm) || norm;
      const tokens = Array.from(set).sort((a, b) => this.compareLineTokens(a, b));
      const isNight = norm.toLowerCase() === '#ffffff';
      let name: string;
      if (isNight) {
        // Etichetta Night: mantengo la parola chiave "Night lines" (usata da
        // legendSubLines/night per elencare le linee bianche reali) + un
        // riassunto tra parentesi delle prime linee, cosi' l'espansione mostra
        // comunque TUTTE le linee bianche reali del dataset.
        const preview = tokens.slice(0, 4).join(', ') + (tokens.length > 4 ? ', …' : '');
        name = `Night lines (${preview})`;
      } else {
        name = (tokens.length === 1 ? 'Line ' : 'Lines ') + tokens.join(', ');
      }
      // primo numero dell'etichetta (per ordinare le righe); onlyR = tutte R.
      const firstNum = tokens.length ? this.lineNumeric(tokens[0]) : Number.POSITIVE_INFINITY;
      const onlyR = tokens.length > 0 && tokens.every((t) => /^r/i.test(t.trim()));
      rows.push({ color: displayColor, name, isNight, firstNum, onlyR });
    }

    // Ordino: (1) Night sempre in fondo; (2) tra i non-Night, i colori con SOLE
    // linee "R" vanno dopo quelli numerici; (3) a parita', per primo numero
    // crescente.
    rows.sort((a, b) => {
      if (a.isNight !== b.isNight) return a.isNight ? 1 : -1;
      if (a.onlyR !== b.onlyR) return a.onlyR ? 1 : -1;
      if (a.firstNum !== b.firstNum) return a.firstNum - b.firstNum;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return rows.map((r) => ({ color: r.color, name: r.name }));
  }

  /** Legenda livery (data-driven). Getter con cache: l'HTML e la logica di
   *  filtro/espansione/popup la usano esattamente come l'array statico di prima. */
  get LINE_LEGEND(): { color: string; name: string }[] {
    if (this.lineLegendCache) return this.lineLegendCache;
    const built = this.buildLineLegend();
    // Metto in cache SOLO se ho davvero costruito qualcosa: se il dataset non e'
    // ancora pronto (built vuoto) ritorno [] senza cache, cosi' al prossimo
    // giro (dati caricati) la legenda viene ricalcolata e comparira'.
    if (built.length) this.lineLegendCache = built;
    return built;
  }

  // ============================================================
  // PATCH-LUCA "lines-legend-by-mode-2026-09-01" (richiesta Luca):
  // La legenda "Transport lines" viene RAGGRUPPATA per MODO di trasporto
  // (Bus / Metro / Tram), leggendo il campo 'transit_type' del geojson linee:
  //   transit_type 3 = bus, 1 = metro, 0 = tram (De Lijn / GTFS route_type).
  // Ogni gruppo ha una INTESTAZIONE cliccabile ("Bus:" / "Metro:" / "Tram:")
  // e sotto le sue righe-colore (identiche a prima: espandibili in singole
  // linee, cliccabili per colore/linea). Comportamento richiesto:
  //   - click su una riga-colore  -> come ora (solo quel colore, dim le altre);
  //   - espando e clicco 1 linea  -> come ora (solo quella linea);
  //   - click sull'intestazione BUS/METRO/TRAM -> si accendono TUTTE le linee
  //     di quel modo; i modi sono COMBINABILI (bus+tram, ecc.); selezionare un
  //     modo azzera i filtri per colore/linea, e viceversa (filtri alternativi).
  //   - click sul vuoto della legenda -> reset totale (tutte le linee).
  //
  // NB: LINE_LEGEND (piatto) resta INVARIATO ed e' ancora usato dal popup
  // click-mappa e dall'ordinamento: qui aggiungo solo un LIVELLO di raggruppa-
  // mento sopra, riusando le stesse righe.
  // ============================================================

  /** Modi di trasporto gestiti, nell'ordine di visualizzazione richiesto. */
  readonly LINE_MODES: { key: 'bus' | 'metro' | 'tram'; label: string }[] = [
    { key: 'bus',   label: 'Bus' },
    { key: 'metro', label: 'Metro' },
    { key: 'tram',  label: 'Tram' },
  ];

  /** Modi attualmente selezionati (intestazioni Bus/Metro/Tram evidenziate).
   *  Vuoto = nessun filtro per modo. Combinabile (piu' modi insieme). */
  selectedLiveryModes = new Set<string>();

  /** PATCH-LUCA "mode-color-pair-key-2026-09-01" (richiesta Luca): coppie
   *  (modo+colore) selezionate cliccando una riga-colore DENTRO un gruppo-modo.
   *  Chiave = 'mode|#colornorm' (es. 'tram|#a60084'). E' il filtro PIU'
   *  specifico: se non vuoto, in mappa restano SOLO le feature la cui coppia
   *  (modo, colore) e' qui dentro. Cosi' la riga ML2 del gruppo Tram accende
   *  solo la tram, mai la metro 9 (stesso colore, modo diverso). */
  selectedLiveryModeColors = new Set<string>();

  /** PATCH-LUCA "combinable-mode-and-line-2026-09-01" (richiesta Luca): SINGOLE
   *  linee accese, chiave 'mode|line' (es. 'metro|9', 'bus|40', 'tram|ML2').
   *  Si COMBINA con selectedLiveryModes: una feature e' visibile se il suo modo
   *  e' selezionato OPPURE la sua linea specifica e' qui dentro. Cosi' si puo'
   *  accendere tutto il Tram + solo la metro 9 + solo il bus 40, insieme. */
  selectedLiveryLineKeys = new Set<string>();

  /** Mappa il valore 'transit_type' del geojson al modo bus/metro/tram.
   *  transit_type: 0 = tram, 1 = metro, 3 = bus (GTFS route_type / De Lijn).
   *  Fallback su 'bus' per valori non riconosciuti (il grosso della rete). */
  private transitTypeToMode(f: any): 'bus' | 'metro' | 'tram' {
    const raw = f?.properties?.['transit_type'];
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (n === 0) return 'tram';
    if (n === 1) return 'metro';
    if (n === 3) return 'bus';
    return 'bus';
  }

  /** Insieme dei COLORI (normalizzati) presenti in ciascun modo, ricavato dal
   *  dataset delle linee. Serve per raggruppare le righe di LINE_LEGEND nei 3
   *  gruppi e per sapere quali colori accendere quando si clicca un modo.
   *  Messo in cache e invalidato insieme alla legenda (invalidateLineLegend). */
  private modeColorsCache: { [mode: string]: Set<string> } | null = null;
  private buildModeColors(): { [mode: string]: Set<string> } {
    const out: { [mode: string]: Set<string> } = { bus: new Set(), metro: new Set(), tram: new Set() };
    let feats: any[] = [];
    const gj = this.dataCache['lines'];
    if (gj && Array.isArray(gj.features)) {
      feats = gj.features;
    } else {
      const layer = this.layerCache.get('heatmap_lines_livery');
      if (layer) { const acc: any[] = []; layer.eachLayer((s: any) => { if (s.feature) acc.push(s.feature); }); feats = acc; }
    }
    for (const f of feats) {
      const rawCol = String(f?.properties?.['color'] ?? '').trim();
      if (!rawCol) continue;
      const mode = this.transitTypeToMode(f);
      out[mode].add(this.normalizeColor(rawCol));
    }
    return out;
  }
  private modeColors(): { [mode: string]: Set<string> } {
    if (!this.modeColorsCache) this.modeColorsCache = this.buildModeColors();
    return this.modeColorsCache;
  }

  /** Legenda livery RAGGRUPPATA per modo. Ogni gruppo contiene le righe di
   *  LINE_LEGEND (stesso oggetto {color,name}) i cui colori appartengono a
   *  quel modo. I gruppi senza righe vengono omessi. Getter con cache. */
  private lineLegendGroupsCache: { key: string; label: string; rows: { color: string; name: string }[] }[] | null = null;
  get LINE_LEGEND_GROUPS(): { key: string; label: string; rows: { color: string; name: string }[] }[] {
    if (this.lineLegendGroupsCache) return this.lineLegendGroupsCache;
    const groups = this.buildLineLegendGroups();
    // Metto in cache solo se ho davvero dei dati (coerente con LINE_LEGEND).
    if (groups.length) this.lineLegendGroupsCache = groups;
    return groups;
  }

  /**
   * PATCH-LUCA "lines-legend-by-mode-solutionA-2026-09-01" (richiesta Luca):
   * Costruisce le righe della legenda RAGGRUPPANDO per COPPIA (modo, colore),
   * NON riusando le righe piatte di LINE_LEGEND.
   *
   * MOTIVO: un COLORE puo' appartenere a piu' modi contemporaneamente (es. il
   * magenta #A60084 e' usato sia dalla tram ML2 sia dalla metro 9; il rosso
   * #ED1C24 dalla tram ML3 e dalla metro 2). Riusando le righe piatte di
   * LINE_LEGEND (una per colore, che elenca TUTTE le linee di quel colore a
   * prescindere dal modo), la stessa riga "Lines ML2, 9" finiva sia sotto Tram
   * sia sotto Metro -> DUPLICATO visibile nella legenda.
   *
   * Con la soluzione A ogni riga e' costruita per la coppia (modo, colore) ed
   * elenca SOLO le linee di quel modo con quel colore: cosi' nel gruppo Tram
   * compare "Line ML2" (solo la tram), e nel gruppo Metro "Line 9" (solo la
   * metro), pur avendo lo stesso colore. Niente piu' sovrapposizioni.
   *
   * Le etichette (Line X / Lines X, Y / Night lines) e l'ordinamento seguono
   * ESATTAMENTE le stesse regole di buildLineLegend(), cosi' aspetto e
   * comportamento (espansione sotto-linee, filtro) restano coerenti.
   */
  private buildLineLegendGroups(): { key: string; label: string; rows: { color: string; name: string }[] }[] {
    // Sorgente feature: stessa priorita' di buildLineLegend / buildModeColors.
    let feats: any[] = [];
    const gj = this.dataCache['lines'];
    if (gj && Array.isArray(gj.features)) {
      feats = gj.features;
    } else {
      const layer = this.layerCache.get('heatmap_lines_livery');
      if (layer) { const acc: any[] = []; layer.eachLayer((s: any) => { if (s.feature) acc.push(s.feature); }); feats = acc; }
    }
    if (!feats.length) return [];

    // Raggruppo i numeri di linea distinti per COPPIA (modo -> colore norm).
    // linesByModeColor[mode] = Map(colorNorm -> Set(line))
    // colorByNorm = colore "originale" da mostrare nello swatch.
    const linesByModeColor: { [mode: string]: Map<string, Set<string>> } = {
      bus: new Map(), metro: new Map(), tram: new Map(),
    };
    const colorByNorm = new Map<string, string>();
    for (const f of feats) {
      const rawCol = String(f?.properties?.['color'] ?? '').trim();
      if (!rawCol) continue;
      const norm = this.normalizeColor(rawCol);
      if (!colorByNorm.has(norm)) colorByNorm.set(norm, rawCol);
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (!ln) continue;
      const mode = this.transitTypeToMode(f);
      const byColor = linesByModeColor[mode];
      if (!byColor.has(norm)) byColor.set(norm, new Set<string>());
      byColor.get(norm)!.add(ln);
    }

    // Costruisco, per ogni modo, le sue righe (una per colore di QUEL modo).
    const groups: { key: string; label: string; rows: { color: string; name: string }[] }[] = [];
    for (const m of this.LINE_MODES) {
      const byColor = linesByModeColor[m.key];
      if (!byColor || !byColor.size) continue;

      type Row = { color: string; name: string; isNight: boolean; firstNum: number; onlyR: boolean };
      const rows: Row[] = [];
      for (const [norm, set] of byColor) {
        const displayColor = colorByNorm.get(norm) || norm;
        const tokens = Array.from(set).sort((a, b) => this.compareLineTokens(a, b));
        const isNight = norm.toLowerCase() === '#ffffff';
        let name: string;
        if (isNight) {
          const preview = tokens.slice(0, 4).join(', ') + (tokens.length > 4 ? ', …' : '');
          name = `Night lines (${preview})`;
        } else {
          name = (tokens.length === 1 ? 'Line ' : 'Lines ') + tokens.join(', ');
        }
        const firstNum = tokens.length ? this.lineNumeric(tokens[0]) : Number.POSITIVE_INFINITY;
        const onlyR = tokens.length > 0 && tokens.every((t) => /^r/i.test(t.trim()));
        rows.push({ color: displayColor, name, isNight, firstNum, onlyR });
      }
      // Stesso ordinamento di buildLineLegend: Night in fondo, poi R, poi numerico.
      rows.sort((a, b) => {
        if (a.isNight !== b.isNight) return a.isNight ? 1 : -1;
        if (a.onlyR !== b.onlyR) return a.onlyR ? 1 : -1;
        if (a.firstNum !== b.firstNum) return a.firstNum - b.firstNum;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

      groups.push({ key: m.key, label: m.label, rows: rows.map((r) => ({ color: r.color, name: r.name })) });
    }

    return groups.filter((g) => g.rows.length > 0);
  }

  /** True se il modo (bus/metro/tram) e' attualmente selezionato (evidenziato). */
  isLiveryModeSelected(mode: string): boolean {
    return this.selectedLiveryModes.has(mode);
  }

  /**
   * Click sull'intestazione di un modo (Bus / Metro / Tram): accende TUTTE le
   * linee di quel modo. Comportamento analogo a onSelectLiveryColor ma sul modo:
   *   - i modi sono COMBINABILI (toggle multi-selezione: bus+tram, ecc.);
   *   - selezionare un modo azzera i filtri per colore/singola linea;
   *   - se il layer e' spento, lo accende mostrando solo quel modo;
   *   - deselezionando l'ultimo modo rimasto, il layer si spegne.
   */
  onSelectLiveryMode(mode: string, ev: Event): void {
    ev.stopPropagation();
    // PATCH-LUCA "combinable-mode-and-line-2026-09-01" (richiesta Luca): il modo
    // si COMBINA con le eventuali linee singole gia' selezionate (NON le azzera).
    // Toggle del modo: se gia' acceso lo tolgo, altrimenti lo aggiungo. Quando
    // aggiungo un modo, rimuovo le sue linee singole ridondanti (il modo intero
    // le comprende gia'), per tenere lo stato pulito.
    const wasOn = this.selectedLiveryModes.has(mode);
    if (wasOn) {
      this.selectedLiveryModes.delete(mode);
    } else {
      this.selectedLiveryModes.add(mode);
      // Tolgo le linee singole di questo modo: ora e' acceso tutto il modo.
      for (const k of Array.from(this.selectedLiveryLineKeys)) {
        if (k.startsWith(mode + '|')) this.selectedLiveryLineKeys.delete(k);
      }
    }

    const layerOff = !this.activeLayers.has('heatmap_lines_livery');
    if (layerOff) {
      // Layer spento -> lo accendo mostrando cio' che e' selezionato.
      this.lineStyleMode = 'livery';
      const other = 'heatmap_lines_freq';
      if (this.activeLayers.has(other)) {
        this.activeLayers.delete(other);
        this.removeLayer(other);
        this.openLegends.delete(other);
      }
      const cfg = this.layers.find((x) => x.id === 'heatmap_lines_livery');
      if (cfg) {
        this.activeLayers.add('heatmap_lines_livery');
        this.loadLayer(cfg); // a fine fetch applica il filtro
      }
      return;
    }

    // Layer acceso: se non resta piu' NULLA di selezionato -> mostro TUTTE le
    // linee (filtro azzerato), lasciando il layer acceso.
    // PATCH-LUCA "empty-selection-shows-all-2026-09-01" (richiesta Luca):
    // prima qui si spegneva il layer; ora invece resta acceso e applyLiveryFilter
    // con i set vuoti rende visibili tutte le linee.
    if (this.selectedLiveryModes.size === 0 && this.selectedLiveryLineKeys.size === 0) {
      this.applyLiveryFilter();
      return;
    }

    this.applyLiveryFilter();
  }

  // ============================================================
  // PATCH-LUCA "lines-legend-by-mode-solutionA-2026-09-01" (richiesta Luca):
  // Selezione di una RIGA-COLORE dentro un gruppo-modo. A differenza di
  // onSelectLiveryColor (che filtra per COLORE, e quindi accenderebbe anche le
  // linee dell'ALTRO modo con lo stesso colore -- es. cliccando la tram ML2
  // #A60084 si sarebbe accesa anche la metro 9, stesso colore), qui filtro per
  // le SINGOLE LINEE esatte della riga (numeri 'line', specifici del modo).
  // Cosi' cliccando "Line ML2" (tram) resta SOLO la ML2, non la metro 9.
  //
  // Riuso lo stesso stato selectedLiveryLines gia' usato per le sotto-voci:
  // il filtro applyLiveryFilter fa match ESATTO sul campo 'line', quindi il
  // colore condiviso tra modi non e' piu' un problema. Toggle multi-selezione
  // (aggiunge/toglie tutte le linee della riga); se resta vuoto, spegne il layer.
  // ============================================================
  onSelectLiveryGroupRow(g: { color: string; name: string }, ev: Event, mode?: string): void {
    ev.stopPropagation();
    // PATCH-LUCA "combinable-mode-and-line-2026-09-01" (richiesta Luca): cliccare
    // una riga-colore accende/spegne TUTTE le linee di quella riga (numeri 'line'
    // del suo modo) come chiavi 'mode|line', COMBINANDOSI con eventuali modi
    // interi o altre linee gia' selezionate (nessun azzeramento).
    const norm = this.normalizeColor(g.color);
    let m = (mode || '').trim();
    if (!m) {
      const mc = this.modeColors();
      for (const k of Object.keys(mc)) { if (mc[k] && mc[k].has(norm)) { m = k; break; } }
    }
    if (!m) return;

    // Linee di QUESTA riga (numeri 'line' che quel modo usa con quel colore).
    const rowLines = this.rowLinesForModeColor(m, norm);
    if (!rowLines.length) return;
    const rowKeys = rowLines.map((ln) => m + '|' + ln);

    // Se il MODO intero e' gia' acceso, cliccare una sua riga lo "esplode" nelle
    // singole linee tranne questa (che spengo), cosi' resta coerente.
    if (this.selectedLiveryModes.has(m)) {
      this.selectedLiveryModes.delete(m);
      for (const ln of this.rowLinesForMode(m)) {
        const k = m + '|' + ln;
        if (!rowKeys.includes(k)) this.selectedLiveryLineKeys.add(k);
      }
    } else {
      // Toggle della riga: se TUTTE le sue linee sono gia' accese -> le spengo;
      // altrimenti le accendo tutte.
      const allOn = rowKeys.every((k) => this.selectedLiveryLineKeys.has(k));
      if (allOn) {
        for (const k of rowKeys) this.selectedLiveryLineKeys.delete(k);
      } else {
        for (const k of rowKeys) this.selectedLiveryLineKeys.add(k);
      }
    }

    this.finishLiverySelectionChange();
  }

  /** Numeri di linea (property 'line') usati da un dato MODO con un dato COLORE
   *  normalizzato. Data-driven dal geojson delle linee. */
  private rowLinesForModeColor(mode: string, norm: string): string[] {
    const feats = this.liveryFeatures();
    const set = new Set<string>();
    for (const f of feats) {
      if (this.transitTypeToMode(f) !== mode) continue;
      const c = this.normalizeColor(String(f?.properties?.['color'] ?? ''));
      if (c !== norm) continue;
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (ln) set.add(ln);
    }
    return Array.from(set);
  }

  /** Tutti i numeri di linea di un MODO (per esplodere un modo intero). */
  private rowLinesForMode(mode: string): string[] {
    const feats = this.liveryFeatures();
    const set = new Set<string>();
    for (const f of feats) {
      if (this.transitTypeToMode(f) !== mode) continue;
      const ln = String(f?.properties?.['line'] ?? '').trim();
      if (ln) set.add(ln);
    }
    return Array.from(set);
  }

  /** Feature del layer linee (dataCache o layer in cache). */
  private liveryFeatures(): any[] {
    const gj = this.dataCache['lines'];
    if (gj && Array.isArray(gj.features)) return gj.features;
    const layer = this.layerCache.get('heatmap_lines_livery');
    if (layer) { const acc: any[] = []; layer.eachLayer((s: any) => { if (s.feature) acc.push(s.feature); }); return acc; }
    return [];
  }

  /** Accende il layer se spento, o lo spegne se non resta nulla selezionato,
   *  altrimenti applica il filtro. Condiviso dagli handler combinabili. */
  private finishLiverySelectionChange(): void {
    const layerOff = !this.activeLayers.has('heatmap_lines_livery');
    if (layerOff) {
      this.lineStyleMode = 'livery';
      const other = 'heatmap_lines_freq';
      if (this.activeLayers.has(other)) {
        this.activeLayers.delete(other);
        this.removeLayer(other);
        this.openLegends.delete(other);
      }
      const cfg = this.layers.find((x) => x.id === 'heatmap_lines_livery');
      if (cfg) {
        this.activeLayers.add('heatmap_lines_livery');
        this.loadLayer(cfg);
      }
      return;
    }
    // PATCH-LUCA "empty-selection-shows-all-2026-09-01" (richiesta Luca): a filtro
    // vuoto il layer resta acceso e applyLiveryFilter mostra TUTTE le linee.
    this.applyLiveryFilter();
  }

  /**
   * PATCH-LUCA "lines-legend-by-mode-solutionA-2026-09-01": dimming di una
   * riga-colore DENTRO un gruppo-modo. La riga resta accesa se almeno una delle
   * sue linee (numeri 'line' del modo) e' selezionata; se un modo intero e'
   * selezionato, resta accesa se una sua linea appartiene a quel modo.
   * Sostituisce isLegendGroupDimmed per le righe raggruppate per modo, cosi' il
   * dimming e' coerente col filtro per singola linea (niente ambiguita' colore).
   */
  isLegendModeRowDimmed(g: { color: string; name: string }, mode?: string): boolean {
    const norm = this.normalizeColor(g.color);
    let m = (mode || '').trim();
    if (!m) {
      const mc = this.modeColors();
      for (const k of Object.keys(mc)) { if (mc[k] && mc[k].has(norm)) { m = k; break; } }
    }
    // Nessuna selezione attiva -> tutte le righe accese.
    if (this.selectedLiveryModes.size === 0 && this.selectedLiveryLineKeys.size === 0) return false;
    // PATCH-LUCA "combinable-mode-and-line-2026-09-01": la riga resta accesa se
    // il suo MODO e' selezionato, OPPURE se ALMENO UNA delle sue linee e'
    // selezionata come singola (chiave 'mode|line').
    if (this.selectedLiveryModes.has(m)) return false;
    const rowLines = this.rowLinesForModeColor(m, norm);
    const anyLineOn = rowLines.some((ln) => this.selectedLiveryLineKeys.has(m + '|' + ln));
    return !anyLineOn;
  }

  // Population coverage (pct_covered): palette viola sequenziale "Purples"
  // a 5 fasce, colori presi 1:1 dal QML pop_coverage.qml. La percentuale
  // indica quanta popolazione della cella e' coperta dal trasporto entro 15 min.
  // Il contorno grigio (#808080) e' quello del QML.
  readonly COVERAGE_LEGEND: { color: string; name: string; range: [number, number] }[] = [
    { color: '#f2f0f7', name: '0%',      range: [0, 0] },
    { color: '#cbc9e2', name: '1-25%',   range: [0.1, 25] },
    { color: '#9e9ac8', name: '25-50%',  range: [25.1, 50] },
    { color: '#756bb1', name: '50-75%',  range: [50.1, 75] },
    { color: '#54278f', name: '75-100%', range: [75.1, 100] },
  ];
  readonly COVERAGE_OUTLINE = '#808080';

  // ============================================================
  // PATCH-LUCA "coverage-thematize-uncovered-2026-08-09" (richiesta Luca):
  // Il layer "Population coverage" puo' ora essere tematizzato in DUE modi,
  // scelti con un toggle "Thematize by population uncovered" sotto la legenda:
  //   - DEFAULT (toggle OFF): colore = pct_covered (banda 1), palette Purples a
  //     5 fasce (COVERAGE_LEGEND), legenda "% of population covered...".
  //   - toggle ON: colore = pop_uncovered (banda 4 = N persone scoperte per
  //     cella), palette REDS a 5 fasce, con soglie NATURAL BREAKS (Jenks) di
  //     QGIS calcolate a RUNTIME sui valori pop_uncovered reali del raster
  //     (stesso algoritmo jenksBreaks usato dal layer Transport stop). La
  //     legenda cambia (rossi + intervalli in N persone scoperte).
  // Premendo il toggle si ricrea il GeoRasterLayer con la banda/palette giusta
  // (reloadCoverageRaster) e si aggiorna la legenda.
  // ============================================================
  coverageThematizeUncovered = false;

  // Palette REDS sequenziale (ColorBrewer) a 5 fasce per la popolazione scoperta.
  // MUTABILE: i range/etichette vengono riscritti a runtime coi break Jenks.
  // I valori qui sotto sono solo il FALLBACK iniziale (prima che il .tif sia letto).
  UNCOVERED_LEGEND: { color: string; name: string; range: [number, number] }[] = [
    { color: '#fee5d9', name: '0',        range: [0, 0] },
    { color: '#fcae91', name: '1-10',     range: [1, 10] },
    { color: '#fb6a4a', name: '11-30',    range: [11, 30] },
    { color: '#de2d26', name: '31-70',    range: [31, 70] },
    { color: '#a50f15', name: '>70',      range: [71, 999999] },
  ];
  // Colori REDS fissi (5), riusati quando riscrivo i range dai break Jenks.
  private readonly UNCOVERED_COLORS = ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'];
  // True quando i break Jenks sono gia' stati calcolati sul raster corrente.
  private uncoveredJenksComputed = false;

  /** Ritorna il colore REDS per una cella coverage dato il numero di persone
   *  SCOPERTE (pop_uncovered). Usa le 5 fasce dinamiche di UNCOVERED_LEGEND.
   *  PATCH-LUCA "uncovered-round-value-2026-09-09" (richiesta Luca): i pixel del
   *  raster sono FLOAT (residenti frazionari per cella). Prima si classificava
   *  il valore grezzo: i valori 0<v<1 non rientravano ne' nella fascia [0,0] ne'
   *  in [1,t1], quindi cadevano nel fallback = fascia PIU' SCURA (rosso). Da qui
   *  celle con "scoperti=0" (popup) mostrate rosse e celle con "scoperti=1"
   *  troppo scure. Ora ARROTONDO il valore (Math.round) PRIMA di classificarlo,
   *  ESATTAMENTE come fa il popup: cosi' colore e numero mostrato coincidono. */
  private colorForUncovered(v: any): string {
    const n = typeof v === 'number' ? v : parseFloat(v);
    const val = isNaN(n) ? 0 : Math.round(n);
    for (const b of this.UNCOVERED_LEGEND) {
      if (val >= b.range[0] && val <= b.range[1]) return b.color;
    }
    return this.UNCOVERED_LEGEND[this.UNCOVERED_LEGEND.length - 1].color;
  }

  /**
   * PATCH-LUCA "coverage-thematize-uncovered-2026-08-09": calcola le 5 classi
   * NATURAL BREAKS (Jenks) di QGIS sui valori pop_uncovered (BANDA 4) del
   * georaster coverage e riscrive IN-PLACE range[] + name[] di UNCOVERED_LEGEND
   * (etichette come "1-10", "11-30", ">70" ...). Considera solo le celle con
   * pop_uncovered > 0 (le celle senza scoperti restano nella fascia "0").
   * Le soglie sono intere (Math.round). La prima fascia e' sempre "0".
   */
  private recomputeUncoveredJenks(): void {
    const gr = this.coverageGeoraster;
    if (!gr || !Array.isArray(gr.values) || !gr.values[3]) return;
    const band = gr.values[3]; // banda 4 = pop_uncovered
    const noData = gr.noDataValue;
    const vals: number[] = [];
    for (let r = 0; r < band.length; r++) {
      const rowArr = band[r];
      if (!rowArr) continue;
      for (let c = 0; c < rowArr.length; c++) {
        const v = rowArr[c];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (noData !== undefined && noData !== null && v === noData) continue;
        // PATCH-LUCA "uncovered-round-value-2026-09-09": arrotondo (come il popup
        // e come colorForUncovered). Cosi' i valori 0<v<1 (che l'utente vede "0")
        // NON entrano nel campione ">0" e non falsano i break Jenks.
        const vr = Math.round(v);
        if (vr > 0) vals.push(vr);
      }
    }
    // 5 classi -> 4 break interni. La prima fascia dedicata a "0", quindi
    // sui valori >0 chiedo 4 classi (3 break interni) e ottengo 5 fasce totali
    // includendo la "0".
    if (vals.length >= 4) {
      const rawBreaks = this.jenksBreaks(vals, 4); // 3 break interni tra i valori >0
      let b = rawBreaks.map((x) => Math.round(x));
      while (b.length < 3) b.push((b.length ? b[b.length - 1] : 0) + 1);
      b = b.slice(0, 3);
      let [t1, t2, t3] = b;
      if (t1 < 1) t1 = 1;
      if (t2 <= t1) t2 = t1 + 1;
      if (t3 <= t2) t3 = t2 + 1;
      const maxV = Math.round(Math.max(...vals));
      const rng = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}\u2013${hi}`);
      const C = this.UNCOVERED_COLORS;
      this.UNCOVERED_LEGEND = [
        { color: C[0], name: '0',                    range: [0, 0] },
        { color: C[1], name: rng(1, t1),             range: [1, t1] },
        { color: C[2], name: rng(t1 + 1, t2),        range: [t1 + 1, t2] },
        { color: C[3], name: rng(t2 + 1, t3),        range: [t2 + 1, t3] },
        { color: C[4], name: `${t3 + 1}\u2013${Math.max(t3 + 1, maxV)}`,      range: [t3 + 1, Math.max(t3 + 1, maxV) + 1] },
      ];
    }
    this.uncoveredJenksComputed = true;
  }

  /**
   * PATCH-LUCA "coverage-thematize-uncovered-2026-08-09": handler del toggle
   * "Thematize by population uncovered". Inverte la modalita' e, se il layer
   * Population coverage e' acceso, ricrea il GeoRasterLayer con la banda/palette
   * corretta. Se il layer e' spento, cambia solo lo stato (la legenda si
   * aggiorna comunque; alla successiva accensione parte gia' nella modalita'
   * scelta). Chiamato dal template (checkbox toggle nella legenda coverage).
   */
  onToggleCoverageUncovered(ev: Event): void {
    ev.stopPropagation();
    this.coverageThematizeUncovered = !this.coverageThematizeUncovered;
    // Se passo a "uncovered" e non ho ancora i break Jenks, li calcolo ora
    // (se il georaster e' gia' stato letto). Se il .tif non e' ancora pronto,
    // verranno calcolati in addCoverageRaster dopo il parse.
    if (this.coverageThematizeUncovered && !this.uncoveredJenksComputed && this.coverageGeoraster) {
      this.recomputeUncoveredJenks();
    }
    // PATCH-LUCA "coverage-toggle-turns-on-layer-2026-08-09" (richiesta Luca):
    // Comportamento richiesto per il toggle "Thematize by population uncovered":
    //   - se lo ATTIVO e il layer Population coverage e' SPENTO -> il layer si
    //     ACCENDE (come premere il suo pulsante), gia' nella modalita' uncovered;
    //   - se lo DISATTIVO -> il layer NON si spegne: resta acceso e torna alla
    //     visualizzazione NORMALE (pct_covered, palette Purples).
    // Per accendere il layer da spento riuso onToggleLayer (stessa meccanica del
    // pulsante), che a sua volta chiama addCoverageRaster: siccome
    // coverageThematizeUncovered e' gia' true, il layer parte direttamente nella
    // tematizzazione "uncovered". Se il layer e' gia' acceso mi limito a
    // ricrearlo con la banda/palette corretta (reloadCoverageRaster).
    if (this.activeLayers.has('pop_coverage_map')) {
      // Layer gia' acceso -> ricreo il GeoRasterLayer con la banda/palette scelta.
      this.reloadCoverageRaster();
    } else if (this.coverageThematizeUncovered) {
      // Layer spento e toggle appena ATTIVATO -> accendo il layer (come il pulsante).
      const cfg = this.layers.find((x) => x.id === 'pop_coverage_map');
      if (cfg) this.onToggleLayer(cfg);
    }
    // (Se il toggle viene DISATTIVATO mentre il layer e' spento: nulla da fare,
    //  il layer resta spento e lo stato torna a "normale".)
    try { this.cdr.detectChanges(); } catch (e) {}
  }

  /**
   * PATCH-LUCA "coverage-thematize-uncovered-2026-08-09": rimuove il
   * GeoRasterLayer coverage corrente e lo ricrea (con la banda/palette scelta
   * dal toggle). Il georaster completo (4 bande) e' gia' in cache in
   * coverageGeoraster, quindi il .tif NON viene riscaricato: addCoverageRaster
   * ripartira' senza rifetch se coverageGeoraster e' gia' valorizzato... ma
   * poiche' addCoverageRaster salta il refetch solo se coverageGeoLayer esiste,
   * qui azzero SOLO coverageGeoLayer (non coverageGeoraster) e ricostruisco il
   * layer dal georaster gia' in memoria.
   */
  private reloadCoverageRaster(): void {
    // Stacco il layer visivo (ma tengo coverageGeoraster per non rifetchare).
    if (this.coverageGeoLayer && this.map && this.map.hasLayer(this.coverageGeoLayer)) {
      this.map.removeLayer(this.coverageGeoLayer);
    }
    this.coverageGeoLayer = null;
    // Ricostruisco il layer dal georaster gia' in memoria (se c'e'), altrimenti
    // addCoverageRaster fara' il fetch da zero.
    this.addCoverageRaster();
  }

  // Transit deserts: simbolo unico rosso semitrasparente (come QML
  // transit_deserts.qml: fill #ff0000 alpha ~0.39, outline #ff0000).
  // Il campo 'pop' = numero di abitanti in area non servita (mostrato nel popup).
  readonly DESERTS_STYLE = { fill: '#ff0000', stroke: '#ff0000', fillOpacity: 0.39 };

  // ============================================================
  // PATCH-LUCA "deserts-jenks-2026-09-09" (richiesta Luca):
  // Il layer "Transit deserts" non usa piu' un COLORE ROSSO UNICO, ma 5 FASCE
  // a NATURAL BREAKS (Jenks) di QGIS sui valori 'pop' (banda 2 = abitanti non
  // serviti per cella), palette REDS sequenziale. L'ULTIMA fascia e'
  // "min soglia - max tot" (es. "115 - 342"). Le soglie sono calcolate a
  // RUNTIME dai valori reali del raster (recomputeDesertsJenks), come per il
  // toggle "population uncovered" del layer Population coverage.
  // DESERTS_LEGEND e' MUTABILE (riscritta dai break Jenks); i valori qui sotto
  // sono solo il FALLBACK iniziale prima del parse del .tif.
  // ============================================================
  DESERTS_LEGEND: { color: string; name: string; range: [number, number] }[] = [
    { color: '#fee5d9', name: '1–10',    range: [1, 10] },
    { color: '#fcae91', name: '11–30',   range: [11, 30] },
    { color: '#fb6a4a', name: '31–70',   range: [31, 70] },
    { color: '#de2d26', name: '71–150',  range: [71, 150] },
    { color: '#a50f15', name: '150 - max', range: [151, 999999] },
  ];
  // Colori REDS fissi (5), riusati quando riscrivo i range dai break Jenks.
  private readonly DESERTS_COLORS = ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'];
  // True quando i break Jenks del layer deserts sono gia' stati calcolati.
  private desertsJenksComputed = false;

  /** Ritorna il colore REDS per una cella deserto dato il numero di abitanti
   *  non serviti ('pop'). Usa le 5 fasce dinamiche di DESERTS_LEGEND. */
  private colorForDesert(v: any): string {
    const n = typeof v === 'number' ? v : parseFloat(v);
    const val = isNaN(n) ? 0 : n;
    for (const b of this.DESERTS_LEGEND) {
      if (val >= b.range[0] && val <= b.range[1]) return b.color;
    }
    return this.DESERTS_LEGEND[this.DESERTS_LEGEND.length - 1].color;
  }

  /**
   * PATCH-LUCA "deserts-jenks-2026-09-09": calcola le 5 classi NATURAL BREAKS
   * (Jenks) di QGIS sui valori 'pop' (BANDA 2) del georaster transit desert e
   * riscrive IN-PLACE range[] + name[] di DESERTS_LEGEND. Considera solo le
   * celle deserto con pop > 0. Soglie intere (Math.ceil). L'ULTIMA fascia e'
   * "min soglia - max" (es. "115 - 342").
   */
  private recomputeDesertsJenks(): void {
    const gr = this.desertsGeoraster;
    if (!gr || !Array.isArray(gr.values)) return;
    // Banda 2 = 'pop' (abitanti non serviti). Se assente, ricado sulla banda 1.
    const band = gr.values[1] || gr.values[0];
    if (!band) return;
    const noData = gr.noDataValue;
    const vals: number[] = [];
    for (let r = 0; r < band.length; r++) {
      const rowArr = band[r];
      if (!rowArr) continue;
      for (let c = 0; c < rowArr.length; c++) {
        const v = rowArr[c];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (noData !== undefined && noData !== null && v === noData) continue;
        if (v > 0) vals.push(v);
      }
    }
    // 5 classi -> 4 break interni.
    if (vals.length >= 5) {
      const rawBreaks = this.jenksBreaks(vals, 5).map((x) => Math.ceil(x));
      let b = rawBreaks.slice(0, 4);
      while (b.length < 4) b.push((b.length ? b[b.length - 1] : 0) + 1);
      // Soglie strettamente crescenti, >=1.
      if (b[0] < 1) b[0] = 1;
      for (let i = 1; i < 4; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1;
      const [t1, t2, t3, t4] = b;
      const maxV = Math.ceil(Math.max(...vals));
      const lastHi = Math.max(t4 + 1, maxV);
      const rng = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}\u2013${hi}`);
      const C = this.DESERTS_COLORS;
      this.DESERTS_LEGEND = [
        { color: C[0], name: rng(1, t1),          range: [1, t1] },
        { color: C[1], name: rng(t1 + 1, t2),     range: [t1 + 1, t2] },
        { color: C[2], name: rng(t2 + 1, t3),     range: [t2 + 1, t3] },
        { color: C[3], name: rng(t3 + 1, t4),     range: [t3 + 1, t4] },
        { color: C[4], name: `${t4 + 1} - ${lastHi}`, range: [t4 + 1, lastHi + 1] },
      ];
    }
    this.desertsJenksComputed = true;
  }

  /** Ritorna il colore Purples per una cella coverage dato pct_covered. */
  private colorForCoverage(pct: any): string {
    const n = typeof pct === 'number' ? pct : parseFloat(pct);
    const val = isNaN(n) ? 0 : n;
    for (const b of this.COVERAGE_LEGEND) {
      if (val >= b.range[0] && val <= b.range[1]) return b.color;
    }
    // >100 o edge: usa la fascia piu' alta
    return this.COVERAGE_LEGEND[this.COVERAGE_LEGEND.length - 1].color;
  }

  /** PathOptions per una cella del layer Population coverage. */
  private styleForCoverage(f: any): L.PathOptions {
    const fill = this.colorForCoverage(f?.properties?.['pct_covered']);
    return {
      color: this.COVERAGE_OUTLINE,
      weight: 0.6,
      fillColor: fill,
      fillOpacity: 0.75,
      opacity: 0.7,
      lineJoin: 'round',
    };
  }

  // ============================================================
  // PATCH-LUCA "coverage-raster-tif-2026-08-27" (richiesta Luca):
  // Il layer "Population coverage" e' ora un GeoTIFF a 4 BANDE (assets/
  // pop_coverage_map.tif, ~107 KB) letto nel browser con georaster +
  // georaster-layer-for-leaflet (stesse librerie del layer Heatmap raster,
  // caricate da CDN in index.html). Cosi' e' LEGGERISSIMO e VELOCE, ma
  // MANTIENE tutte le info del vecchio GeoJSON:
  //   banda 1 = pct_covered   -> usata per COLORARE (palette Purples 5 fasce)
  //   banda 2 = pop_tot       -> residenti nella cella
  //   banda 3 = pop_covered   -> residenti coperti
  //   banda 4 = pop_uncovered -> residenti scoperti
  // Al click sulla mappa leggo il pixel su TUTTE e 4 le bande e apro un popup
  // con: percentuale coperta, N abitanti, N coperti, N scoperti.
  // nodata = -1 (celle assenti -> pixel trasparente, nessun popup).
  // ============================================================
  private readonly COVERAGE_TIF = 'assets/pop_coverage_map.tif';
  private coverageGeoLayer: any = null;
  private coverageGeoraster: any = null;
  private _coverageClick: ((e: L.LeafletMouseEvent) => void) | null = null;
  private coverageLoading = false;

  /**
   * PATCH-LUCA "coverage-raster-tif-2026-08-27": aggiunge in mappa il GeoTIFF
   * coverage come GeoRasterLayer. Colora ogni pixel in base alla BANDA 1
   * (pct_covered) con la palette Purples a 5 fasce (colorForCoverage), identica
   * al vecchio layer. Carica/parsea il .tif una sola volta, poi lo mette nel
   * polygonsPane (sotto linee e fermate) e aggancia il click.
   */
  private addCoverageRaster(): void {
    const place = () => {
      if (!this.coverageGeoLayer) return;
      if (!this.map.hasLayer(this.coverageGeoLayer)) {
        this.coverageGeoLayer.addTo(this.map);
      }
      this.attachCoverageClick();
    };
    if (this.coverageGeoLayer) { place(); return; }
    if (this.coverageLoading) return;
    this.coverageLoading = true;

    const parseGeoraster = (window as any).parseGeoraster;
    const GeoRasterLayer = (window as any).GeoRasterLayer;
    if (!parseGeoraster || !GeoRasterLayer) {
      console.error('[coverage-raster] librerie georaster non caricate (index.html)');
      this.coverageLoading = false;
      return;
    }

    fetch(this.COVERAGE_TIF)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject('tif coverage non trovato')))
      .then((buf) => parseGeoraster(buf))
      .then((georaster: any) => {
        // Conservo il georaster COMPLETO (4 bande) per leggere pct/pop/coperti/
        // scoperti al click.
        this.coverageGeoraster = georaster;
        const noData = georaster.noDataValue;

        // PATCH-LUCA "coverage-thematize-uncovered-2026-08-09": se sono in
        // modalita' "population uncovered" e non ho ancora calcolato i break
        // Jenks (5 classi Reds) sui valori pop_uncovered del raster, li calcolo
        // ora (il georaster e' appena stato parsato).
        if (this.coverageThematizeUncovered && !this.uncoveredJenksComputed) {
          this.recomputeUncoveredJenks();
        }

        // PATCH-LUCA "coverage-raster-singleband-render-2026-08-27" (fix "layer non
        // appare"): il .tif ha 4 BANDE (colorinterp 'gray'). georaster-layer-for-
        // leaflet, vedendo >1 banda, tende a interpretarle come immagine RGBA e
        // NON usa correttamente pixelValuesToColorFn -> il layer risultava
        // trasparente/invisibile. Costruisco quindi un georaster MONO-BANDA
        // da dare al GeoRasterLayer per il COLORE. La BANDA usata dipende dalla
        // modalita' (PATCH-LUCA "coverage-thematize-uncovered-2026-08-09"):
        //   - default            -> banda 1 (index 0) = pct_covered  (palette Purples)
        //   - "population uncovered" -> banda 4 (index 3) = pop_uncovered (palette Reds Jenks)
        // Il click continua a leggere le 4 bande dall'oggetto coverageGeoraster
        // completo salvato sopra.
        const uncovered = this.coverageThematizeUncovered;
        const bandIdx = uncovered ? 3 : 0;
        const singleBand = {
          ...georaster,
          numberOfRasters: 1,
          values: [georaster.values[bandIdx]],
          mins: Array.isArray(georaster.mins) ? [georaster.mins[bandIdx]] : georaster.mins,
          maxs: Array.isArray(georaster.maxs) ? [georaster.maxs[bandIdx]] : georaster.maxs,
        };

        this.coverageGeoLayer = new GeoRasterLayer({
          georaster: singleBand,
          // PATCH-LUCA "coverage-raster-fix-pane-2026-08-27": uso linesPane
          // (z-index 420) come il layer "Heatmap raster" che funziona, cosi'
          // il raster e' SEMPRE sopra la basemap e ben visibile.
          pane: 'linesPane',
          opacity: 0.8,
          resolution: 256,
          // Colore = palette scelta dalla modalita': Purples 5 fasce su
          // pct_covered (default) OPPURE Reds 5 fasce Jenks su pop_uncovered
          // (toggle "population uncovered"). nodata / <0 -> trasparente.
          pixelValuesToColorFn: (values: number[]) => {
            const v = values[0];
            if (v === null || v === undefined || isNaN(v)) return null;
            if (noData !== undefined && noData !== null && v === noData) return null;
            if (v < 0) return null; // celle assenti -> trasparente
            // PATCH-LUCA "coverage-uncovered-zero-transparent-2026-09-08"
            // (richiesta Luca, rev3): nella tematizzazione "population uncovered" la
            // fascia 0 (nessuno scoperto) NON deve piu' vedersi in mappa: ritorno null
            // (pixel completamente trasparente). Cliccando una cella a 0% (ora
            // invisibile) NON deve nemmeno aprirsi il popup: vedi attachCoverageClick,
            // dove in modalita' uncovered i pixel con pop_uncovered<=0 vengono ignorati.
            // PATCH-LUCA "uncovered-round-value-2026-09-09" (richiesta Luca): i pixel
            // sono FLOAT. Un valore 0<v<1 (che il popup ARROTONDA a "0") deve essere
            // TRASPARENTE come uno 0 esatto; e uno 0.6 (popup="1") deve colorarsi come
            // 1. Quindi arrotondo (Math.round) e uso il valore arrotondato sia per la
            // soglia di trasparenza sia per la classificazione del colore.
            if (uncovered) {
              const vr = Math.round(v);
              if (vr <= 0) return null;
              return this.colorForUncovered(vr);
            }
            return this.colorForCoverage(v);
          },
        });
        this.zone.run(() => place());
      })
      .catch((err: any) => { console.error('[coverage-raster] errore caricamento tif', err); })
      .then(() => { this.coverageLoading = false; });
  }

  /**
   * PATCH-LUCA "coverage-raster-tif-2026-08-27": aggancia (una volta) il click
   * sulla mappa che legge il pixel del .tif coverage sotto al punto cliccato su
   * TUTTE e 4 le bande e apre il popup con: % coperta, N abitanti (pop_tot),
   * N coperti (pop_covered), N scoperti (pop_uncovered).
   */
  private attachCoverageClick(): void {
    if (this._coverageClick) return; // gia' agganciato
    this._coverageClick = (e: L.LeafletMouseEvent) => {
      const gr = this.coverageGeoraster;
      if (!gr) return;
      const lng = e.latlng.lng;
      const lat = e.latlng.lat;
      if (lng < gr.xmin || lng > gr.xmax || lat < gr.ymin || lat > gr.ymax) return;
      const col = Math.floor((lng - gr.xmin) / gr.pixelWidth);
      const row = Math.floor((gr.ymax - lat) / gr.pixelHeight);
      const readBand = (bi: number): number | null => {
        try {
          const band = gr.values[bi];
          if (band && band[row] && band[row][col] !== undefined) return band[row][col];
        } catch (_) { /* no-op */ }
        return null;
      };
      const pct = readBand(0);          // banda 1 = pct_covered
      if (pct === null || pct === undefined) return;
      if (gr.noDataValue !== undefined && gr.noDataValue !== null && pct === gr.noDataValue) return;
      if (pct < 0) return;              // cella assente: nessun popup
      const popTot = readBand(1) ?? 0;  // banda 2 = pop_tot
      const popCov = readBand(2) ?? 0;  // banda 3 = pop_covered
      const popUnc = readBand(3) ?? 0;  // banda 4 = pop_uncovered
      // PATCH-LUCA "coverage-uncovered-zero-transparent-2026-09-08" (richiesta Luca):
      // in modalita' "Thematize by population uncovered" le celle a 0 scoperti sono
      // rese INVISIBILI in mappa; cliccandole NON deve comparire alcun popup.
      if (this.coverageThematizeUncovered && popUnc <= 0) return;
      const html = this.buildCoverageCellPopupHtml(pct, popTot, popCov, popUnc, this.coverageThematizeUncovered);
      L.popup({ className: 'lz-popup', maxWidth: 240 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(this.map);
    };
    this.map.on('click', this._coverageClick);
  }

  /** PATCH-LUCA "coverage-raster-tif-2026-08-27": rimuove il GeoTIFF coverage
   *  dalla mappa e stacca il click. */
  private removeCoverageRaster(): void {
    if (this.coverageGeoLayer && this.map.hasLayer(this.coverageGeoLayer)) {
      this.map.removeLayer(this.coverageGeoLayer);
    }
    if (this._coverageClick) {
      this.map.off('click', this._coverageClick);
      this._coverageClick = null;
    }
  }

  /** HTML del popup di una cella Population coverage: percentuale coperta +
   *  numero abitanti (residenti), coperti e scoperti. */
  private buildCoverageCellPopupHtml(pct: number, popTot: number, popCov: number, popUnc: number, uncoveredMode: boolean = false): string {
    const pctTxt = Math.round(pct) + '%';
    const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
    const dashPurple = '#5b1179';
    const dashFont = `'Inter','Segoe UI',Roboto,sans-serif`;
    // PATCH-LUCA "coverage-popup-uncovered-order-2026-09-08" (richiesta Luca):
    // SOLO in modalita' "Thematize by population uncovered" il popup usa un ORDINE
    // DIVERSO delle righe (i COLORI restano identici: viola dash per titolo/%/
    // Residents, verde per Covered, rosso per Uncovered):
    //   Population coverage
    //   <Uncovered N>  Uncovered   (in cima, evidenziato grande come la %)
    //   Covered <N>
    //   Residents <N>
    //   <pct%> covered           (in fondo)
    // In modalita' normale (pct_covered) il popup resta ESATTAMENTE come prima.
    if (uncoveredMode) {
      return `
      <div class="lzp" style="font:700 13px/1.45 ${dashFont};font-weight:700;min-width:170px">
        <div style="font-weight:700;color:${dashPurple};letter-spacing:.2px;margin-bottom:4px">
          Population coverage
        </div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
          <span style="font-size:20px;font-weight:700;color:#991b1b">${fmt(popUnc)}</span>
          <span style="font-size:12px;font-weight:700;color:#991b1b">Uncovered</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#166534;padding:1px 0">
          <span>Covered</span><span style="font-weight:700">${fmt(popCov)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:${dashPurple};padding:1px 0">
          <span>Residents</span><span style="font-weight:700">${fmt(popTot)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:${dashPurple};padding:1px 0">
          <span>% Covered</span><span style="font-weight:700">${Math.round(pct)}</span>
        </div>
      </div>`;
    }
    // Modalita' DEFAULT (pct_covered): ordine originale.
    return `
      <div class="lzp" style="font:700 13px/1.45 ${dashFont};font-weight:700;min-width:170px">
        <div style="font-weight:700;color:${dashPurple};letter-spacing:.2px;margin-bottom:4px">
          Population coverage
        </div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
          <span style="font-size:20px;font-weight:700;color:${dashPurple}">${pctTxt}</span>
          <span style="font-size:12px;font-weight:700;color:${dashPurple}">covered</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:${dashPurple};padding:1px 0">
          <span>Residents</span><span style="font-weight:700">${fmt(popTot)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#166534;padding:1px 0">
          <span>Covered</span><span style="font-weight:700">${fmt(popCov)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#991b1b;padding:1px 0">
          <span>Uncovered</span><span style="font-weight:700">${fmt(popUnc)}</span>
        </div>
      </div>`;
  }

  // ============================================================
  // PATCH-LUCA "transit-desert-as-tif-2026-09-08" (richiesta Luca):
  // Il layer "Transit deserts" e' ora un GeoTIFF a 3 BANDE (assets/
  // transit_desert.tif, ~27 KB) letto nel browser con georaster +
  // georaster-layer-for-leaflet (stesse librerie del layer Population coverage,
  // caricate da CDN in index.html), allineato pixel-perfect a pop_coverage_map
  // .tif. Cosi' e' LEGGERISSIMO e VELOCE, ma MANTIENE tutte le info del vecchio
  // GeoJSON transit_deserts.geojson:
  //   banda 1 = pop_uncovered -> usata per COLORARE (rosso semitrasparente, QML)
  //   banda 2 = pop           -> abitanti non serviti (mostrati nel popup)
  //   banda 3 = pct_covered   -> percentuale coperta (della cella)
  // Al click sulla mappa leggo il pixel e apro un popup IDENTICO al vecchio
  // (titolo "Transit desert", numero abitanti "stranded" + descrizione).
  // La logica di colore/popup e' calcata 1:1 su addCoverageRaster (che gia'
  // funziona per pop_coverage_map.tif). nodata (-1 / <=0) -> pixel trasparente,
  // nessun popup, esattamente come per la coverage.
  // ============================================================
  private readonly DESERTS_TIF = 'assets/transit_desert.tif';
  private desertsGeoLayer: any = null;
  private desertsGeoraster: any = null;
  private _desertsClick: ((e: L.LeafletMouseEvent) => void) | null = null;
  private desertsLoading = false;

  // PATCH-LUCA "deserts-red-cell-borders-2026-09-09" (richiesta Luca): il layer
  // "Transit deserts" resta ESATTAMENTE COM'E' (rosso semitrasparente), ma OGNI
  // CELLA-deserto ha in piu' un BORDO ROSSO. Il .tif e' un raster e la
  // pixelValuesToColorFn puo' dare solo un colore di RIEMPIMENTO (niente bordi
  // per cella), quindi i bordi rossi vengono disegnati come un layer VETTORIALE
  // SOVRAPPOSTO: un rettangolo (contorno rosso, nessun fill) per ogni pixel-
  // deserto, ricostruito a runtime dai pixel del georaster gia' parsato
  // (desertsGeoraster.values + xmin/ymax/pixelWidth/pixelHeight). Le celle
  // deserto sono poche (~3k), rese con un renderer CANVAS dedicato -> nessun
  // impatto sulle performance. Vedi addDesertsCellBorders / removeDesertsCellBorders.
  private desertsBordersLayer: L.LayerGroup | null = null;
  // Renderer canvas dedicato ai bordi cella (molti rettangoli sottili).
  private desertsBordersRenderer: L.Canvas = L.canvas({ padding: 0.5 });

  /**
   * PATCH-LUCA "transit-desert-as-tif-2026-09-08": aggiunge in mappa il GeoTIFF
   * transit desert come GeoRasterLayer. Colora ogni pixel "deserto" (banda 1 =
   * pop_uncovered > 0) col rosso semitrasparente del QML (DESERTS_STYLE), come
   * il vecchio poligono. Carica/parsea il .tif una sola volta, lo mette nel
   * linesPane (come la coverage) e aggancia il click.
   */
  private addDesertsRaster(): void {
    const place = () => {
      if (!this.desertsGeoLayer) return;
      if (!this.map.hasLayer(this.desertsGeoLayer)) {
        this.desertsGeoLayer.addTo(this.map);
      }
      this.attachDesertsClick();
      // PATCH-LUCA "deserts-red-cell-borders-2026-09-09": aggiungo i bordi rossi
      // per ogni cella-deserto (layer vettoriale sovrapposto al raster).
      this.addDesertsCellBorders();
    };
    if (this.desertsGeoLayer) { place(); return; }
    if (this.desertsLoading) return;
    this.desertsLoading = true;

    const parseGeoraster = (window as any).parseGeoraster;
    const GeoRasterLayer = (window as any).GeoRasterLayer;
    if (!parseGeoraster || !GeoRasterLayer) {
      console.error('[deserts-raster] librerie georaster non caricate (index.html)');
      this.desertsLoading = false;
      return;
    }

    fetch(this.DESERTS_TIF)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject('tif transit desert non trovato')))
      .then((buf) => parseGeoraster(buf))
      .then((georaster: any) => {
        // Conservo il georaster COMPLETO (3 bande) per leggere pop_uncovered /
        // pop / pct_covered al click.
        this.desertsGeoraster = georaster;
        const noData = georaster.noDataValue;

        // PATCH-LUCA "deserts-revert-single-red-2026-09-09" (richiesta Luca):
        // NON calcolo piu' le classi Jenks per il LAYER (il layer torna rosso
        // unico). Le soglie Jenks restano SOLO nel grafico desDist.
        // (recomputeDesertsJenks disattivato qui.)

        // Come per la coverage: georaster-layer-for-leaflet con >1 banda tende a
        // interpretarle come RGBA (layer invisibile). Costruisco un georaster
        // MONO-BANDA per il COLORE. PATCH-LUCA "deserts-jenks-2026-09-09": uso
        // la BANDA 2 = 'pop' (abitanti non serviti) cosi' il colore riflette le
        // 5 fasce Jenks; il click legge comunque le 3 bande da desertsGeoraster.
        // La cella e' "deserto" se banda 1 (pop_uncovered) > 0.
        const bandColorIdx = 0; // banda 1 = pop_uncovered (definisce il deserto)
        const singleBand = {
          ...georaster,
          numberOfRasters: 1,
          values: [georaster.values[bandColorIdx]],
          mins: Array.isArray(georaster.mins) ? [georaster.mins[bandColorIdx]] : georaster.mins,
          maxs: Array.isArray(georaster.maxs) ? [georaster.maxs[bandColorIdx]] : georaster.maxs,
        };

        this.desertsGeoLayer = new GeoRasterLayer({
          georaster: singleBand,
          // linesPane (z-index 420), come Population coverage/Heatmap raster,
          // cosi' il raster e' sopra la basemap e ben visibile.
          pane: 'linesPane',
          // fillOpacity del QML (~0.39): applico l'opacita' all'intero layer.
          opacity: this.DESERTS_STYLE.fillOpacity,
          resolution: 256,
          // PATCH-LUCA "deserts-jenks-2026-09-09": colore = 5 fasce Jenks REDS
          // sul valore 'pop' della cella (colorForDesert). nodata / <=0 ->
          // trasparente (non-deserto / cella assente).
          pixelValuesToColorFn: (values: number[]) => {
            const v = values[0];
            if (v === null || v === undefined || isNaN(v)) return null;
            if (noData !== undefined && noData !== null && v === noData) return null;
            if (v <= 0) return null; // non-deserto / cella assente -> trasparente
            return this.DESERTS_STYLE.fill;
          },
        });
        this.zone.run(() => place());
      })
      .catch((err: any) => { console.error('[deserts-raster] errore caricamento tif', err); })
      .then(() => { this.desertsLoading = false; });
  }

  /**
   * PATCH-LUCA "deserts-red-cell-borders-2026-09-09" (richiesta Luca): disegna
   * un BORDO ROSSO attorno a OGNI cella-deserto, sovrapposto al raster (che
   * resta invariato, rosso semitrasparente). Ricostruisce a runtime i rettangoli
   * dai PIXEL del georaster gia' parsato (desertsGeoraster): per ogni pixel con
   * banda 1 (pop_uncovered) > 0 crea un L.rectangle con SOLO contorno rosso
   * (nessun fill, cosi' non altera il colore attuale). I rettangoli finiscono
   * in un LayerGroup dedicato reso con un renderer CANVAS (regge bene le ~3k
   * celle). Le celle-deserto sono tipicamente adiacenti: i loro bordi combaciano
   * formando una griglia rossa. Chiamato da addDesertsRaster.place().
   */
  private addDesertsCellBorders(): void {
    const gr = this.desertsGeoraster;
    if (!gr || !Array.isArray(gr.values) || !gr.values[0]) return;
    // Se gia' costruito, mi limito a riattaccarlo (evita doppioni).
    if (this.desertsBordersLayer) {
      if (!this.map.hasLayer(this.desertsBordersLayer)) this.desertsBordersLayer.addTo(this.map);
      return;
    }
    const band = gr.values[0]; // banda 1 = pop_uncovered (definisce il deserto)
    const noData = gr.noDataValue;
    const xmin = gr.xmin;
    const ymax = gr.ymax;
    const pw = gr.pixelWidth;
    const ph = gr.pixelHeight;
    if (![xmin, ymax, pw, ph].every((n) => typeof n === 'number' && isFinite(n))) return;

    const rects: L.Rectangle[] = [];
    const outline = this.DESERTS_STYLE.stroke; // '#ff0000'
    for (let row = 0; row < band.length; row++) {
      const rowArr = band[row];
      if (!rowArr) continue;
      for (let col = 0; col < rowArr.length; col++) {
        const v = rowArr[col];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (noData !== undefined && noData !== null && v === noData) continue;
        if (v <= 0) continue; // non-deserto: nessun bordo
        // Bounds geografici del pixel (cella) in lat/lng.
        const west = xmin + col * pw;
        const east = west + pw;
        const north = ymax - row * ph;
        const south = north - ph;
        const rect = L.rectangle(
          [[south, west], [north, east]] as L.LatLngBoundsLiteral,
          {
            pane: 'linesPane',
            renderer: this.desertsBordersRenderer,
            color: outline,   // bordo rosso
            weight: 1,
            opacity: 1,
            fill: false,      // nessun riempimento: il colore lo da' gia' il raster
            interactive: false,
          },
        );
        rects.push(rect);
      }
    }
    this.desertsBordersLayer = L.layerGroup(rects);
    this.desertsBordersLayer.addTo(this.map);
  }

  /** PATCH-LUCA "deserts-red-cell-borders-2026-09-09": rimuove il layer dei
   *  bordi rossi delle celle-deserto dalla mappa (senza distruggerlo, cosi' il
   *  toggle successivo lo riattacca senza ricostruire tutti i rettangoli). */
  private removeDesertsCellBorders(): void {
    if (this.desertsBordersLayer && this.map.hasLayer(this.desertsBordersLayer)) {
      this.map.removeLayer(this.desertsBordersLayer);
    }
  }

  /**
   * PATCH-LUCA "transit-desert-as-tif-2026-09-08": aggancia (una volta) il click
   * sulla mappa che legge il pixel del .tif transit desert sotto al punto
   * cliccato e apre lo STESSO popup del vecchio geojson: titolo "Transit desert"
   * + abitanti non serviti (banda 2 = pop). Se il pixel non e' un deserto
   * (pop_uncovered <= 0 / nodata) NON apre alcun popup.
   */
  private attachDesertsClick(): void {
    if (this._desertsClick) return; // gia' agganciato
    this._desertsClick = (e: L.LeafletMouseEvent) => {
      const gr = this.desertsGeoraster;
      if (!gr) return;
      const lng = e.latlng.lng;
      const lat = e.latlng.lat;
      if (lng < gr.xmin || lng > gr.xmax || lat < gr.ymin || lat > gr.ymax) return;
      const col = Math.floor((lng - gr.xmin) / gr.pixelWidth);
      const row = Math.floor((gr.ymax - lat) / gr.pixelHeight);
      const readBand = (bi: number): number | null => {
        try {
          const band = gr.values[bi];
          if (band && band[row] && band[row][col] !== undefined) return band[row][col];
        } catch (_) { /* no-op */ }
        return null;
      };
      const popUnc = readBand(0);       // banda 1 = pop_uncovered (definisce il deserto)
      if (popUnc === null || popUnc === undefined) return;
      if (gr.noDataValue !== undefined && gr.noDataValue !== null && popUnc === gr.noDataValue) return;
      if (popUnc <= 0) return;           // non-deserto: nessun popup
      // banda 2 = pop (abitanti in area non servita), il valore mostrato dal
      // vecchio popup geojson (property 'pop'). Fallback su pop_uncovered.
      const pop = readBand(1);
      const popShown = (pop != null && pop > 0) ? pop : popUnc;
      const html = this.buildDesertCellPopupHtml(popShown);
      L.popup({ className: 'lz-popup', maxWidth: 240 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(this.map);
    };
    this.map.on('click', this._desertsClick);
  }

  /** PATCH-LUCA "transit-desert-as-tif-2026-09-08": rimuove il GeoTIFF transit
   *  desert dalla mappa e stacca il click. */
  private removeDesertsRaster(): void {
    if (this.desertsGeoLayer && this.map.hasLayer(this.desertsGeoLayer)) {
      this.map.removeLayer(this.desertsGeoLayer);
    }
    if (this._desertsClick) {
      this.map.off('click', this._desertsClick);
      this._desertsClick = null;
    }
    // PATCH-LUCA "deserts-red-cell-borders-2026-09-09": tolgo anche i bordi rossi.
    this.removeDesertsCellBorders();
  }

  /** HTML del popup di una cella Transit desert: IDENTICO a quello del vecchio
   *  geojson (titolo "Transit desert", numero grande = abitanti non serviti
   *  "residents stranded", + descrizione). */
  private buildDesertCellPopupHtml(pop: number): string {
    const accent = '#dc2626';
    const val = Math.round(pop).toLocaleString('en-US');
    const unit = Math.round(pop) === 1 ? 'resident stranded' : 'residents stranded';
    return `
      <div class="lzp" style="font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;min-width:180px">
        <div class="lzp-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="width:10px;height:10px;border-radius:50%;background:${accent};flex:0 0 auto;box-shadow:0 0 0 3px ${accent}22"></span>
          <span style="font-weight:700;color:#1f2937;letter-spacing:.2px">Transit desert</span>
        </div>
        <div style="display:flex;align-items:baseline;gap:6px;margin:2px 0 8px">
          <span style="font-size:26px;font-weight:800;color:${accent};line-height:1">${val}</span>
          <span style="font-size:12px;color:#6b7280">${unit}</span>
        </div>
        <div style="font-size:12px;color:#6b7280">People here lack usable public-transport access.</div>
      </div>`;
  }

  /** PathOptions per un poligono del layer Transit deserts (colore unico). */
  private styleForDeserts(_f: any): L.PathOptions {
    return {
      color: this.DESERTS_STYLE.stroke,
      weight: 1,
      fillColor: this.DESERTS_STYLE.fill,
      fillOpacity: this.DESERTS_STYLE.fillOpacity,
      opacity: 0.9,
      lineJoin: 'round',
    };
  }

  // ============================================================
  // PATCH-LUCA "population-2025-layer":
  // Legenda e stile del layer Population 2025 (tasselli GHS-POP 100x100 m).
  // Ogni cella ha 'pop' = numero di abitanti. Palette YlOrRd->bordeaux a 6
  // fasce (stessi colori del PNG generato in pop_2025_layer.json).
  // Soglie scelte sui dati reali (pop per cella 1..177): fasce crescenti che
  // separano bene le celle poco abitate da quelle dense del centro.
  // ============================================================
  readonly POP_LEGEND: { color: string; name: string; range: [number, number] }[] = [
    { color: '#ffffb2', name: '1-10',    range: [1,   10]    },
    { color: '#fecc5c', name: '11-25',   range: [11,  25]    },
    { color: '#fd8d3c', name: '26-50',   range: [26,  50]    },
    { color: '#f03b20', name: '51-90',   range: [51,  90]    },
    { color: '#bd0026', name: '91-140',  range: [91,  140]   },
    { color: '#67000d', name: '140+',    range: [141, 999999]},
  ];
  readonly POP_OUTLINE = '#7a0011';

  /** Ritorna il colore della fascia popolazione per una cella dato 'pop'. */
  private colorForPop(pop: any): string {
    const n = typeof pop === 'number' ? pop : parseFloat(pop);
    const val = isNaN(n) ? 0 : n;
    for (const b of this.POP_LEGEND) {
      if (val >= b.range[0] && val <= b.range[1]) return b.color;
    }
    return this.POP_LEGEND[0].color;
  }

  /** PathOptions per una cella (tassello) del layer Population 2025. */
  private styleForPopulation(f: any): L.PathOptions {
    const fill = this.colorForPop(f?.properties?.['pop']);
    return {
      color: this.POP_OUTLINE,
      weight: 0.3,
      fillColor: fill,
      fillOpacity: 0.8,
      opacity: 0.35,
      lineJoin: 'round',
    };
  }

  constructor(private sanitizer: DomSanitizer, private zone: NgZone, private cdr: ChangeDetectorRef) {
    // PATCH-LUCA "categories-v2":
    // ordine richiesto: transport, entertainment, marketing, park,
    //                   postbank, restaurant, shop, overall
    // La 'prop' e' il nome del campo nel geojson (potrebbe non esistere
    // per marketing/postbank/restaurant/shop: in tal caso il poligono
    // resta grigio, come previsto in styleForPolygon).
    // PATCH-LUCA "categories-v3": lista definitiva 9 pulsanti nell'ordine
    // richiesto: transport, entertainment, education, health, marketgroc,
    // park, postbank, restaurant, shop, overall.
    // NB: 'marketing' e' stato sostituito da 'marketgroc' (mercato/generi
    // alimentari).
    // PATCH-LUCA "only-transport-category":
    // Su richiesta dell'utente in sidebar resta UNA SOLA categoria: Transport,
    // resa come pulsante lungo (full-width, uno per riga) con la sua icona,
    // selezionabile come prima. Le altre 9 categorie sono state rimosse.
    const specs: [string, string, string][] = [
      ['transport',       'Transport stop accessibility',     'transport_stop'],
    ];
    this.categories = specs.map(([id, label, prop]) => ({
      id,
      label,
      prop,
      iconHtml: this.sanitizer.bypassSecurityTrustHtml(this.ICONS_RAW[id] || ''),
    }));

    // PATCH-LUCA "layer-buttons-like-transport":
    // assegno a ciascun layer di sidebar la sua icona SVG (stesso stile di
    // Transport), cosi' i 3 pulsanti layer appaiono identici al pulsante
    // categoria: icona a sinistra + etichetta.
    this.layers.forEach((l) => {
      l.iconHtml = this.sanitizer.bypassSecurityTrustHtml(this.ICONS_RAW[l.id] || '');
    });
  }

  /**
   * PATCH-LUCA "data-driven-initial-view" (richiesta Luca 2026-08-05):
   * Adatta la vista della mappa ai BOUNDS del confine comunale, letti da
   * assets/city_bounds.json. Il file (generato dallo step 00 della pipeline a
   * partire da lau_eurostat.gpkg) ha formato:
   *   { "bounds": [[south, west], [north, east]], "center": [lat, lon], "name": "..." }
   * Chiama map.fitBounds(bounds) cosi' l'intera area del comune e' visibile
   * all'avvio, per QUALSIASI citta'. Se il file manca o e' malformato, non fa
   * nulla (la mappa resta sul fallback impostato in ngAfterViewInit).
   */
  /**
   * PATCH-LUCA "city-name-data-driven" (richiesta Luca): imposta il nome della
   * citta' (usato nei titoli) e aggiorna anche il <title> della tab del browser.
   * Il nome arriva da assets/city_bounds.json (campo "name"), prodotto dallo
   * step 00 della pipeline a partire dal confine comunale lau_eurostat.gpkg.
   */
  private setCityName(name: string): void {
    this.cityName = name;
    // Titolo della tab del browser: "<Citta'> public transport accessibility".
    try {
      document.title = `${name} public transport accessibility`;
    } catch (e) { /* ambiente senza document: ignoro */ }
  }

  private fitToCityBounds(): void {
    fetch('assets/city_bounds.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        this.zone.run(() => {
          // PATCH-LUCA "city-name-data-driven": leggo anche il nome della citta'
          // (campo "name", estratto dallo step 00 dal confine lau_eurostat) e lo
          // uso nei titoli della dashboard (h1, pannello Analytics, tab).
          if (data && typeof data.name === 'string' && data.name.trim()) {
            this.setCityName(data.name.trim());
          }
          const b = data && Array.isArray(data.bounds) ? data.bounds : null;
          if (
            Array.isArray(b) && b.length === 2 &&
            Array.isArray(b[0]) && b[0].length === 2 &&
            Array.isArray(b[1]) && b[1].length === 2
          ) {
            const bounds = L.latLngBounds(
              L.latLng(b[0][0], b[0][1]),
              L.latLng(b[1][0], b[1][1]),
            );
            if (bounds.isValid()) {
              // PATCH-LUCA "initial-view-fit-height-negpad-2026-09-04" (richiesta Luca):
              // Vista con confine NORD sul bordo ALTO e confine SUD sul bordo
              // BASSO del riquadro mappa (#map), centrato; a est/ovest il comune
              // puo' uscire dai lati.
              //
              // I TENTATIVI PRECEDENTI:
              //  - fitBounds normale: rispetta le proporzioni; riquadro widescreen
              //    + comune ~quadrato => comanda la LARGHEZZA => DEZOOM eccessivo.
              //  - calcolo zoom con map.getSize().y: l'altezza di #map dipende da
              //    --charts-h (variabile CSS regolata a runtime) e NON e' ancora
              //    definitiva quando questa promise (fetch) risolve => getSize()
              //    stantio => SUPERZOOM. Da NON usare qui.
              //
              // SOLUZIONE ROBUSTA (nessuna misura runtime): fitBounds con PADDING
              // NEGATIVO orizzontale enorme (sinistra/destra). Cosi' Leaflet
              // "crede" che il riquadro sia MOLTO piu' largo di com'e' e il vincolo
              // della larghezza sparisce: a comandare l'inquadratura resta
              // l'ALTEZZA => nord/sud toccano i bordi alto/basso. Il padding
              // verticale (top/bottom) resta piccolo (aria minima). E' dichiarativo
              // e non dipende da getSize()/timing.
              //   - PAD_Y  = margine verticale in px (alza => filo d'aria sopra/sotto)
              //   - PAD_X_NEG = quanto "allargo" virtualmente il riquadro ai lati
              //                 (grande = la larghezza non vincola mai).
              // PATCH-LUCA "initial-view-zoom-in-1-2026-09-04" (richiesta Luca):
              // la vista con PAD_Y=4 era ancora troppo DEZOOMMATA -> serve ~1
              // livello di zoom IN. Passo PAD_Y da 4 a un valore NEGATIVO (-160):
              // un padding verticale NEGATIVO fa "credere" a Leaflet che il
              // riquadro sia PIU' ALTO -> il fit sull'altezza zooma di piu' (il
              // confine nord/sud "escono" un filo oltre i bordi alto/basso). Se
              // serve ancora piu'/meno zoom, ritoccare SOLO PAD_Y (piu' negativo
              // = piu' zoom in; verso 0 = meno).
              try { this.map.invalidateSize({ animate: false, pan: false }); } catch (e) {}
              const PAD_Y = -160;
              const PAD_X_NEG = 4000;
              // PATCH-LUCA "initial-view-shift-up-2026-09-04" (richiesta Luca):
              // la vista appariva leggermente DECENTRATA verso il BASSO (mappa
              // troppo in basso). Per ALZARE il centro rendo il padding verticale
              // ASIMMETRICO: aggiungo SHIFT_UP px di padding SOLO in BASSO
              // (paddingBottomRight.y), lasciando invariato quello in alto. Un
              // padding inferiore maggiore "spinge" il contenuto verso l'ALTO nel
              // riquadro, alzando il centro. Regolazione: aumentare SHIFT_UP per
              // alzare di piu' il centro; 0 = centrato come prima.
              const SHIFT_UP = 90;
              this.map.fitBounds(bounds, {
                paddingTopLeft: L.point(-PAD_X_NEG, PAD_Y),
                paddingBottomRight: L.point(-PAD_X_NEG, PAD_Y + SHIFT_UP),
                animate: false,
              });
            }
          }
        });
      })
      .catch((err) => { console.error('[city-bounds] non caricati', err); });
  }

  ngAfterViewInit(): void {
    this.map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      // PATCH-LUCA "map-pinch-no-page-zoom-2026-08-05": zoom rotellina e pinch
      // trackpad gestiti da Leaflet (non dal browser). touchZoom:true fa si'
      // che il gesto pinch venga catturato dalla mappa; abbinato a
      // touch-action:none nel CSS impedisce lo zoom di PAGINA del browser.
      scrollWheelZoom: true,
      touchZoom: true,
    }).setView([50.8798, 4.7005], 13);

    // PATCH-LUCA "data-driven-initial-view" (richiesta Luca 2026-08-05):
    // La vista iniziale NON e' piu' hardcoded su Leuven. All'avvio la mappa si
    // adatta automaticamente ai BOUNDS del confine comunale (lau_eurostat.gpkg),
    // caricati da assets/city_bounds.json (generato dallo step 00 della pipeline,
    // sincronizzato dallo step 09). Cosi' si vede SEMPRE l'intera area coperta
    // dal comune, a prescindere dalla citta' (Leuven, Madrid, ...).
    // Il setView([50.8798,4.7005],13) qui sopra e' solo un fallback provvisorio
    // (sovrascritto subito dal fitBounds appena il JSON e' disponibile). Se il
    // file mancasse, la mappa resta sul fallback senza errori.
    this.fitToCityBounds();

    // PATCH-LUCA "basemap-dropdown":
    // Applico la basemap iniziale (activeBasemapId = 'carto_light' = comportamento precedente).
    // La logica di aggiunta/sostituzione del tileLayer e' centralizzata in applyBasemap().
    this.applyBasemap(this.activeBasemapId);

    // PATCH-LUCA "heatmap-freq-by-mode-2026-09-03": precarico il JSON delle
    // soglie Jenks per modo (Total/Metro/Tram/Bus), cosi' il menu "Service
    // type" e la legenda numerica della Heatmap frequency sono pronti appena
    // l'utente apre la legenda / accende il layer.
    this.loadHeatmapSoglie();


    // PATCH-LUCA "z-order-panes":
    // Creo 3 pane custom per garantire l'ordine di rendering richiesto:
    //   polygonsPane (410) -> esagoni 15-minute (sotto)
    //   linesPane    (420) -> linee bus (sopra gli esagoni)
    //   stopsPane    (430) -> fermate (sopra tutto)
    // Le pane di default di Leaflet sono: tilePane=200, overlayPane=400,
    // shadowPane=500, markerPane=600, tooltipPane=650, popupPane=700.
    // Uso zIndex 410-430 per stare tra overlayPane e markerPane.
    this.map.createPane('polygonsPane').style.zIndex = '410';
    this.map.createPane('linesPane').style.zIndex = '420';
    this.map.createPane('stopsPane').style.zIndex = '430';

    // PATCH-LUCA "initial-loading-overlay-2026-09-14" (richiesta Luca): spengo la
    // rotella di caricamento INIZIALE (overlay #loadingOverlay sulla mappa) quando
    // la mappa Leaflet ha finito di posizionarsi e ha caricato le prime tile
    // (evento 'load'), cosi' l'utente vede lo spinner mentre la mappa si prepara e
    // poi svanisce appena e' pronta. Aggancio anche un timeout di sicurezza (3.5s)
    // nel caso l'evento 'load' non scatti (es. rete lenta): l'overlay non deve mai
    // restare bloccato. hideInitialLoading() e' idempotente (initialLoadingDone).
    this.map.whenReady(() => {
      // whenReady scatta quando la mappa ha centro/zoom validi. Do un piccolo
      // margine (400ms) perche' le prime tile della basemap si disegnino, poi
      // nascondo l'overlay con la sua transizione di fade-out.
      setTimeout(() => this.hideInitialLoading(), 400);
    });
    // Timeout di sicurezza: qualunque cosa accada, dopo 3.5s l'overlay sparisce.
    setTimeout(() => this.hideInitialLoading(), 3500);

    // PATCH-LUCA "map-ctrl-wheel-zoom-2026-08-05" (FIX DEFINITIVO):
    // Il pinch del TRACKPAD = evento 'wheel' con ctrlKey=true. Di default il
    // browser lo usa per lo ZOOM DI PAGINA (ingrandisce tutta la dashboard).
    // Questo capita SOPRATTUTTO percepibile con Heatmap frequency perche' e'
    // un imageOverlay (<img>), ma la causa a monte e' l'evento wheel+ctrlKey.
    // SOLUZIONE STANDARD PER LEAFLET: sul SOLO container della mappa aggiungo un
    // listener 'wheel' NON-passivo che, quando ctrlKey e' true:
    //   1) chiama preventDefault()  -> il browser NON zooma piu' la pagina;
    //   2) applica lo zoom ALLA MAPPA manualmente (setZoomAround sul punto del
    //      cursore), cosi' il pinch zooma la mappa come ci si aspetta, su
    //      QUALSIASI layer (immagine inclusa).
    // Essendo agganciato SOLO al container mappa (in bubbling, non globale),
    // NON rompe il pinch-zoom/scroll altrove nella pagina.
    const mapEl2 = this.map.getContainer();
    const ctrlWheelZoom = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // rotellina normale: la gestisce Leaflet (scrollWheelZoom)
      e.preventDefault();      // blocca lo zoom-pagina del browser
      e.stopPropagation();
      try {
        // deltaY < 0 = pinch-out (zoom in); deltaY > 0 = pinch-in (zoom out).
        // Passo dolce (0.6 livelli) proporzionale all'intensita' del gesto.
        const delta = -e.deltaY;
        const step = Math.max(-1, Math.min(1, delta / 100)) * 0.6;
        const rect = mapEl2.getBoundingClientRect();
        const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
        const latlng = this.map.containerPointToLatLng(point);
        const newZoom = this.map.getZoom() + step;
        // setZoomAround mantiene fermo il punto sotto il cursore (come un vero pinch).
        this.zone.run(() => this.map.setZoomAround(latlng, newZoom, { animate: false }));
      } catch (err) { /* no-op */ }
    };
    const ffBlockPageZoom = (e: WheelEvent) => {
      if (e.ctrlKey) {
        try { e.preventDefault(); } catch (err) {}
      }
    };
    // PATCH-LUCA "runOutsideAngular-passive-fix-2026-08-05" (LA CAUSA VERA):
    // Nella pagina di test isolata il preventDefault() FUNZIONA (prevented=true,
    // pagina non zooma). Nella dashboard NO. Differenza: qui i listener sono
    // registrati dentro ngAfterViewInit = dentro la NgZone di Angular. Zone.js
    // fa il monkey-patch di addEventListener e tratta wheel/touch come PASSIVI,
    // IGNORANDO { passive:false } -> il nostro preventDefault() viene scartato
    // (browser: "Unable to preventDefault inside passive event listener") e la
    // pagina zooma. SOLUZIONE: registrare i listener FUORI dalla zona Angular
    // con this.zone.runOutsideAngular(), cosi' Zone.js NON li intercetta e
    // { passive:false } viene RISPETTATO davvero. (Dentro gli handler, quando
    // serve aggiornare lo stato/mappa, si rientra con this.zone.run().)
    this.zone.runOutsideAngular(() => {
      mapEl2.addEventListener('wheel', ctrlWheelZoom, { passive: false });
      window.addEventListener('wheel', ffBlockPageZoom, { passive: false });
    });
    this._blockCtrlWheel = ctrlWheelZoom as any;
    this._blockCtrlWheelEl = mapEl2;
    this._blockCtrlWheelEl2 = window as any; // marcatore per il cleanup
    (this as any)._ffBlockPageZoom = ffBlockPageZoom;


    // PATCH-LUCA "freq-raster-img-no-gesture-2026-08-05" (FIX DEFINITIVO CORRETTO):
    // CAUSA VERA (individuata da Luca): il layer Heatmap frequency e' un
    // L.imageOverlay, cioe' un elemento <img> nel DOM. Sul pinch trackpad il
    // browser interpreta il gesto come "zoom/drag DELL'IMMAGINE" invece che
    // della mappa -> zooma tutta la dashboard. Sugli altri layer (SVG/canvas
    // vettoriali) questo NON succede e il pinch-zoom Leaflet funziona normale.
    // SOLUZIONE MIRATA: rendere il PNG "trasparente ai gesti" con
    // pointer-events:none, user-select:none e -webkit-user-drag:none (via la
    // className 'freq-raster-smooth' gia' applicata all'overlay, vedi CSS).
    // Cosi' il pinch sopra la heatmap va alla mappa come per ogni altro layer,
    // e NON serve alcun blocco globale (che invece rompeva il pinch normale).
    // NB v1/v2 (listener wheel+ctrlKey globale in capture) RIMOSSI: bloccavano
    // lo zoom-pinch legittimo su TUTTI i layer. Il fix corretto e' sull'IMG.

    // PATCH-LUCA "freq-shape-select": click su un punto VUOTO della mappa
    // (non su una shape) -> reset della selezione frequency (tutte le shapes
    // tornano piene, info-box chiuso).
    this.map.on('click', () => {
      if (this.freqSelectedShapeId || this.freqInfo) {
        this.zone.run(() => this.resetFreqSelection());
      }
    });

    for (const l of this.layers) {
      if (l.defaultOn) {
        // PATCH-LUCA "stops-on-by-default": oltre a disegnare il layer sulla
        // mappa, lo registro anche in activeLayers cosi' il relativo pulsante
        // in sidebar risulta ACCESO fin dall'avvio (coerenza UI/mappa).
        this.activeLayers.add(l.id);
        // PATCH-LUCA "line-style-on-init": i layer 'heatmap_lines_livery' e
        // 'heatmap_lines_freq' condividono lo STESSO geojson e si distinguono
        // solo tramite lineStyleMode ('livery' vs 'qml'). All'avvio bypassiamo
        // onToggleLayer(), quindi lineStyleMode resterebbe al default 'qml' e le
        // linee verrebbero colorate come "Heatmap frequency" pur avendo acceso
        // "Transport lines". Replico qui la stessa scelta di stile.
        if (l.id === 'heatmap_lines_livery' || l.id === 'heatmap_lines_freq') {
          this.lineStyleMode = l.id === 'heatmap_lines_livery' ? 'livery' : 'qml';
        }
        this.loadLayer(l);
      }
    }

    // PATCH-LUCA "preload-polygons-no-lag":
    // Precarico in background il GeoJSON dei poligoni Transport (1.5MB) subito
    // dopo l'init della mappa, cosi' al primo click su Transport i dati sono
    // gia' in cache e l'animazione parte istantaneamente (niente lag da fetch).
    this.preloadPolygons();

    // PATCH-LUCA "stop-schedule-panel": precarico il JSON con gli orari
    // settimanali di tutte le fermate (per il pannello che si apre al click
    // su una fermata).
    // PATCH-LUCA "stop-info-panel-4numbers" (2026-09-02): i preload legacy dei
    // tabelloni orari (preloadScheduleData / preloadDaysIndex / preloadWeekStats)
    // sono DISATTIVATI: quei file (stop_boards*, stop_week_stats) non esistono
    // piu' e generavano solo 404 in console. Il pannello fermata ora usa solo
    // stop_info.json, caricato da preloadStopStats().
    // this.preloadScheduleData();
    // this.preloadDaysIndex();

    // PATCH-LUCA "stop-stats-thematize": precarico stop_stats.json (statistiche
    // per fermata: total/daily/hourly/shapes) per le 4 nuove tematizzazioni.
    this.preloadStopStats();

    // PATCH-LUCA "stop-freq-full-week-7days-RAW": precarico stop_week_stats.json
    // (metriche di frequenza per settimana, calcolate dai dati grezzi GTFS sui
    // 7 giorni reali) usate dalla riga stats del popup orari.
    // PATCH-LUCA "stop-info-panel-4numbers" (2026-09-02): preloadWeekStats
    // DISATTIVATO (stop_week_stats.json non esiste piu').
    // this.preloadWeekStats();

    // PATCH-LUCA "charts-sections-per-button": definisco le sezioni grafici
    // (una per pulsante sidebar + Transport) e precarico TUTTI i GeoJSON
    // necessari; buildAllCharts() istanzia i grafici quando i dati sono pronti.
    this.defineChartSections();
    // FIX-LUCA "ng0100-chartsections": defineChartSections() popola
    // this.chartSections DURANTE ngAfterViewInit, quando Angular ha gia'
    // completato il primo giro di change-detection -> il template (*ngFor su
    // chartSections, app.component.html:357) vedeva '[]' e poi il valore pieno,
    // generando NG0100 ExpressionChangedAfterItHasBeenCheckedError. Forzo un
    // detectChanges() esplicito per allineare la view nello stesso ciclo.
    this.cdr.detectChanges();
    window.setTimeout(() => this.preloadAllChartData(), 0);
  }

  /**
   * PATCH-LUCA "charts-sections-per-button": (deprecato kickDrawerCharts).
   * Mantenuto come no-op per compatibilita' con eventuali chiamate residue.
   */
  private kickDrawerCharts(): void {
    window.setTimeout(() => this.buildAllCharts(), 0);
  }

  // ============================================================
  // PATCH-LUCA "charts-drawer":
  // Pannello grafici "a tendina" sotto la mappa. Logica di resize copiata da
  // esempio_sezione_grafici/dashboard_embedded.html (setupChartsResize):
  //   - L'handle in cima al pannello si trascina su/giu (mouse o touch).
  //   - Trascinando verso l'ALTO il pannello cresce (la mappa si accorcia);
  //     verso il BASSO si richiude fino a MIN_PANEL_H.
  //   - L'altezza e' clampata tra MIN_PANEL_H e (altezza .map-col - MIN_MAP_H)
  //     cosi' la mappa non scende mai sotto 120px.
  //   - Al termine (e durante) il drag chiamo map.invalidateSize() cosi'
  //     Leaflet ricalcola le dimensioni senza tile "tagliate".
  //   - Il corpo del pannello (.charts-panel-body) ha overflow-y:auto:
  //     mettendoci il cursore sopra si scrolla verso il basso per consultarlo.
  // ============================================================

  /** Altezza attuale del pannello grafici (px). Bind su [style.height.px]. */
  chartsHeight = 160;
  /** True mentre l'utente sta trascinando l'handle di resize. */
  chartsDragging = false;

  private readonly CHARTS_MIN_PANEL_H = 44;  // pannello mai sotto (resta l'handle+header)
  private readonly CHARTS_MIN_MAP_H = 120;   // mappa mai sotto 120px
  private chartsRafId: number | null = null;
  private chartsPendingH: number | null = null;

  // ============================================================
  // PATCH-LUCA "charts-sections-per-button":
  // MOTORE GRAFICI DATA-DRIVEN. Una SEZIONE per ogni pulsante della sidebar
  // (+ Transport), ciascuna con un numero PARI di grafici (2/4/6) costruiti
  // dai GeoJSON reali. Ogni chart-spec ha un builder(datasets) che ritorna la
  // config Chart.js. I canvas nel template hanno [data-cid]="sec.id__ch.id":
  // buildAllCharts() li recupera con querySelector e istanzia i grafici.
  //
  // Sorgenti dati (precaricate in this.dataCache):
  //   polygons -> transport_15min.geojson (transport_stop = minuti)
  //   stops    -> stops_clipped.geojson (lines_count, is_terminal, routes)
  //   lines    -> line.geojson (frequency, start_period, ...)
  //   coverage -> pop_coverage_map.geojson (pct_covered)
  //   deserts  -> transit_deserts.geojson (pop non servita)
  //   pop      -> RIMOSSO (era pop_2025_cells.geojson): il campo 'pop' e' ora letto dall'alias 'coverage' (pop_coverage_map.geojson)
  // ============================================================

  /** Cache dei GeoJSON grezzi per le sezioni grafici (chiave = alias). */
  private dataCache: { [k: string]: any } = {};

  /** Istanze Chart.js create (chiave = data-cid), per distruggerle/ricrearle. */
  private chartInstances: { [cid: string]: any } = {};

  /** Palette condivise. */
  private readonly WALK_COLORS = ['#22c55e', '#eab308', '#f59e0b', '#ef4444', '#7f1d1d'];
  private readonly FREQ_COLORS = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];
  private readonly POP_COLORS  = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026', '#67000d'];
  private readonly PURPLES     = ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'];
  private readonly PERIOD_ORDER = ['Morning Peak', 'Midday', 'Evening Peak', 'Night'];
  private readonly PERIOD_COLORS: { [k: string]: string } = {
    'Morning Peak': '#f59e0b', 'Midday': '#22c55e', 'Evening Peak': '#8b5cf6', 'Night': '#1e3a8a',
  };

  /**
   * Definizione delle SEZIONI e dei GRAFICI. Ogni chart ha:
   *   id, title, sub?, type UI (via builder), wide?/tall? (layout),
   *   build(): ritorna la config Chart.js (o null se dati assenti).
   * L'ordine delle sezioni segue la sidebar: Transport, Transport stop,
   * Transport lines, Heatmap frequency, Population coverage, Transit deserts,
   * Population 2025 (+ una sezione combinata finale).
   */
  chartSections: {
    id: string;
    title: string;
    subtitle: string;
    charts: { id: string; title: string; sub?: string; info?: string; wide?: boolean; tall?: boolean; build: () => any | null }[];
  }[] = [];

  // ============================================================
  // PATCH-LUCA "analytics-kpi-metrics":
  // Riga di METRICHE (KPI) mostrate in cima al pannello "Leuven Transit —
  // Analytics", una accanto all'altra, ciascuna con NOME in alto e sotto il
  // NUMERO con unita' di misura. I valori sono calcolati a runtime dai GeoJSON
  // reali in dataCache (computeKpiMetrics), cosi' restano allineati ai dati.
  // Ogni metrica: { label, value, unit }.
  // ============================================================
  kpiMetrics: { label: string; value: string; unit: string }[] = [];

  // ============================================================
  // PATCH-LUCA "kpi-by-mode-2026-09-04" (richiesta Luca):
  // La riga di KPI in cima al pannello Analytics e' ora CLICCABILE: al click si
  // apre/chiude un MENU A TENDINA con le stesse metriche di trasporto/rete
  // calcolate SEPARATAMENTE per SERVICE TYPE (bus / metro / tram), disposte in
  // una tabella (righe = modi, colonne = metriche). Restano ESCLUSE dal menu
  // (perche' non hanno senso per-modo) Pop tot, Pop uncovered, Total area.
  // I dati arrivano gia' PRONTI dal campo 'kpi_by_mode' di assets/analytics.json
  // (calcolato dalla pipeline, step 08e). Struttura:
  //   { labels: string[],
  //     rows: [ { mode: 'bus', cells: [{label,value,unit}, ...] }, ... ] }
  // kpiByMode  = dati letti dal JSON (null finche' non caricato / assente).
  // kpiExpanded = stato aperto/chiuso del menu a tendina.
  // ============================================================
  kpiByMode: {
    labels: string[];
    rows: { mode: string; cells: { label: string; value: string; unit: string; tooltip?: string; url?: string }[] }[];
  } | null = null;
  kpiExpanded = false;

  /** True se ci sono davvero dati per-modo da mostrare (almeno una riga). */
  get hasKpiByMode(): boolean {
    return !!(this.kpiByMode && Array.isArray(this.kpiByMode.rows) && this.kpiByMode.rows.length > 0);
  }

  /** Etichetta leggibile di un modo (bus -> Bus, ecc.). */
  kpiModeLabel(mode: string): string {
    const m = String(mode || '').trim();
    return m ? m.charAt(0).toUpperCase() + m.slice(1) : m;
  }

  /** Apre/chiude il menu a tendina delle KPI per service type. */
  toggleKpiExpand(): void {
    if (!this.hasKpiByMode) return; // niente da espandere
    this.kpiExpanded = !this.kpiExpanded;
  }

  // ============================================================
  // PATCH-LUCA "mode-agencies-collapsed-2026-11-09" (richiesta Luca):
  // Sotto la riga di KPI in alto (e SOLO quando la tabella per SERVICE TYPE e'
  // CHIUSA, cioe' !kpiExpanded) va mostrata, per ogni modo realmente presente
  // (bus/metro/tram), una riga:
  //     Bus:  <nome agenzia cliccabile col link agency_url>  <date range>
  //     Metro: <nome agenzia cliccabile>  <date range>
  //     Tram:  <nome agenzia cliccabile>  <date range>
  // I dati sono presi 1:1 dalle stesse celle gia' calcolate in kpi_by_mode
  // (cella "Agencies" -> value=agency_id, url=agency_url, tooltip=agency_name;
  // cella "Date range" -> value "dd/mm/aaaa - dd/mm/aaaa"). Quando l'utente
  // ESPANDE i KPI, questo blocco si NASCONDE (lo mostra solo *ngIf="!kpiExpanded")
  // e resta la tabella completa; richiudendo, il blocco riappare.
  // I metodi qui sotto estraggono la cella giusta di una riga-modo per LABEL,
  // in modo generico e robusto (l'ordine delle colonne puo' cambiare).
  // ============================================================

  /** Ritorna la cella (label/value/unit/tooltip/url) di una riga-modo il cui
   *  label corrisponde (case-insensitive) a quello passato; null se assente. */
  private kpiModeCellByLabel(
    row: { mode: string; cells: { label: string; value: string; unit: string; tooltip?: string; url?: string }[] },
    label: string,
  ): { label: string; value: string; unit: string; tooltip?: string; url?: string } | null {
    if (!row || !Array.isArray(row.cells)) return null;
    const want = String(label || '').trim().toLowerCase();
    for (const c of row.cells) {
      if (String(c?.label || '').trim().toLowerCase() === want) return c;
    }
    return null;
  }

  /** Cella "Agencies" della riga-modo (value=agency_id, url=agency_url,
   *  tooltip=agency_name). Usata dal blocco agenzie-per-modo sotto i KPI. */
  kpiModeAgencyCell(
    row: { mode: string; cells: { label: string; value: string; unit: string; tooltip?: string; url?: string }[] },
  ): { label: string; value: string; unit: string; tooltip?: string; url?: string } | null {
    return this.kpiModeCellByLabel(row, 'Agencies');
  }

  /** Valore "Date range" (dd/mm/aaaa - dd/mm/aaaa) della riga-modo, oppure ''. */
  kpiModeDateRange(
    row: { mode: string; cells: { label: string; value: string; unit: string; tooltip?: string; url?: string }[] },
  ): string {
    const c = this.kpiModeCellByLabel(row, 'Date range');
    return c ? String(c.value || '') : '';
  }

  /** True se almeno una riga-modo ha l'informazione "Agencies" (cosi' il blocco
   *  agenzie-per-modo compare solo quando c'e' davvero qualcosa da mostrare). */
  get hasKpiModeAgencies(): boolean {
    if (!this.hasKpiByMode) return false;
    return this.kpiByMode!.rows.some((r) => !!this.kpiModeAgencyCell(r));
  }

  /** Formatta un numero con separatore delle migliaia (locale en-US) e decimali opzionali. */
  private fmtNum(n: number, decimals = 0): string {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  /** Area approssimata (m^2) di una feature poligonale (shoelace su lon/lat convertiti in metri). */
  private featureAreaM2(f: any): number {
    const g = f?.geometry; if (!g || !g.coordinates) return 0;
    const ringArea = (ring: number[][]): number => {
      if (!ring || ring.length < 3) return 0;
      const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const mLat = 111320.0;
      const mLon = 111320.0 * Math.cos(lat0 * Math.PI / 180);
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const x1 = ring[i][0] * mLon, y1 = ring[i][1] * mLat;
        const x2 = ring[i + 1][0] * mLon, y2 = ring[i + 1][1] * mLat;
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a) / 2;
    };
    let tot = 0;
    if (g.type === 'Polygon') { tot += ringArea(g.coordinates[0]); }
    else if (g.type === 'MultiPolygon') { for (const poly of g.coordinates) tot += ringArea(poly[0]); }
    return tot;
  }

  /**
   * PATCH-LUCA "analytics-precomputed-2026-08-28": le 10 metriche KPI ora
   * arrivano GIA' PRONTE (label/value/unit) da assets/analytics.json, calcolate
   * dalla pipeline (step 08e) con la STESSA identica matematica di prima. Qui
   * mi limito a copiarle. Se per qualche motivo analytics non e' disponibile,
   * uso il FALLBACK storico che le ricalcola dai GeoJSON in dataCache (cosi' la
   * dashboard resta robusta anche senza il file precalcolato).
   */
  private computeKpiMetrics(): void {
    // Percorso veloce: KPI precalcolate dalla pipeline.
    if (this.analytics && Array.isArray(this.analytics.kpi) && this.analytics.kpi.length) {
      this.kpiMetrics = this.analytics.kpi.map((k: any) => ({
        label: String(k?.label ?? ''),
        value: String(k?.value ?? '\u2014'),
        unit: String(k?.unit ?? ''),
      }));
      // PATCH-LUCA "kpi-by-mode-2026-09-04": copio anche il breakdown per
      // service type (bus/metro/tram), se presente nel JSON, per il menu a
      // tendina cliccabile sotto la riga KPI.
      const bm = this.analytics.kpi_by_mode;
      if (bm && Array.isArray(bm.rows) && bm.rows.length) {
        this.kpiByMode = {
          labels: (bm.labels || []).map((s: any) => String(s ?? '')),
          rows: bm.rows.map((r: any) => ({
            mode: String(r?.mode ?? ''),
            cells: (r?.cells || []).map((c: any) => ({
              label: String(c?.label ?? ''),
              value: String(c?.value ?? '\u2014'),
              unit: String(c?.unit ?? ''),
              // PATCH-LUCA "agencies-id-name-tooltip-2026-09-09": tooltip opzionale
              // della cella (es. per "Agencies" = nome completo dell'agenzia,
              // mostrato al passaggio del mouse). Copiato solo se presente nel JSON.
              tooltip: (c?.tooltip != null ? String(c.tooltip) : undefined),
              // PATCH-LUCA "agency-url-clickable-2026-11-09" (richiesta Luca): url
              // opzionale della cella (es. per "Agencies" = agency_url letto da
              // agency.txt). Se presente, il template rende il valore (agency_id)
              // come LINK cliccabile verso il sito ufficiale (nuova scheda),
              // esattamente come gia' avviene per fermate e linee.
              url: (c?.url != null ? String(c.url) : undefined),
            })),
          })),
        };
      } else {
        this.kpiByMode = null;
      }
      return;
    }
    // ---- FALLBACK storico (ricalcolo dai GeoJSON), invariato ----
    const linesF: any[] = this.dataCache['lines']?.features || [];
    const stopsF: any[] = this.dataCache['stops']?.features || [];
    const desertsF: any[] = this.dataCache['deserts']?.features || [];
    const popF: any[] = this.dataCache['coverage']?.features || [];
    const polysF: any[] = this.dataCache['polygons']?.features || [];
    const num = (x: any): number => { const v = parseFloat(x); return isNaN(v) ? 0 : v; };

    // Lunghezza tracciati (shape_ext in metri) -> km
    const shapeExtSum = linesF.reduce((s, f) => s + num(f?.properties?.['shape_ext']), 0);
    const totalKm = shapeExtSum / 1000;
    const avgLenKm = linesF.length ? (shapeExtSum / linesF.length / 1000) : 0;
    // Linee uniche
    const uniqueRoutes = new Set(linesF.map(f => String(f?.properties?.['line']))).size;
    // Trip totali = somma frequency
    const totalTrips = linesF.reduce((s, f) => s + num(f?.properties?.['frequency']), 0);
    // Fermate
    const totalStops = stopsF.length;
    // Popolazione totale e non coperta
    const popTot = popF.reduce((s, f) => s + num(f?.properties?.['pop']), 0);
    const popUncovered = desertsF.reduce((s, f) => s + num(f?.properties?.['pop']), 0);
    // Area rete (km^2) dai poligoni 15-min
    const netAreaKm2 = polysF.reduce((s, f) => s + this.featureAreaM2(f), 0) / 1e6;
    const stopDensity = netAreaKm2 ? (totalStops / netAreaKm2) : 0;

    // PATCH-LUCA "kpi-reorder-rename-2026-09-08" (richiesta Luca): il FALLBACK
    // storico segue lo STESSO ordine/etichette dei KPI precalcolati (16_gen_
    // analytics.py -> build_kpi): Total area (solo se disponibile), Total stops,
    // Stop density, Avg km/day (ex Total km/day), Avg trip/day (ex Total trips),
    // Total lines (ex Unique routes), Pop tot, Pop uncovered. RIMOSSI dai KPI:
    // "Avg route len" e "Network area". NB: nel fallback "Total area" (superficie
    // LAU) non e' disponibile (serve il layer LAU lato pipeline) quindi non
    // compare; la Stop density qui usa la Network area come denominatore di
    // ripiego, coerente col fallback storico.
    const avgKmDay = totalKm;       // ex "Total km/day"
    const avgTripDay = totalTrips;  // ex "Total trips"
    const totalLines = uniqueRoutes; // ex "Unique routes"

    this.kpiMetrics = [
      { label: 'Total stops',   value: this.fmtNum(totalStops),     unit: '' },
      { label: 'Stop density',  value: this.fmtNum(stopDensity, 1), unit: 'stops/km²' },
      { label: 'Avg km/day',    value: this.fmtNum(avgKmDay),       unit: 'km' },
      { label: 'Avg trip/day',  value: this.fmtNum(avgTripDay),     unit: 'trips' },
      { label: 'Total lines',   value: this.fmtNum(totalLines),     unit: '' },
      { label: 'Pop tot',       value: this.fmtNum(popTot),         unit: 'inhab.' },
      { label: 'Pop uncovered', value: this.fmtNum(popUncovered),   unit: 'inhab.' },
    ];
  }

  // ---- Helper generici -------------------------------------------------

  /** Estrae un array di numeri da una property di un GeoJSON in cache. */
  private nums(alias: string, prop: string, map61 = false): number[] {
    const gj = this.dataCache[alias];
    const feats: any[] = (gj && Array.isArray(gj.features)) ? gj.features : [];
    const out: number[] = [];
    for (const f of feats) {
      let raw = f?.properties?.[prop];
      if (raw === undefined || raw === null || raw === '') continue;
      if (map61 && raw === '> 60') { out.push(61); continue; }
      const v = typeof raw === 'number' ? raw : parseFloat(raw);
      if (!isNaN(v)) out.push(v);
    }
    return out;
  }

  /** Conta i valori in fasce [edges] (semiaperte a dx, ultima inclusiva su +inf). */
  private binCounts(vals: number[], edges: number[]): number[] {
    const counts = new Array(edges.length - 1).fill(0);
    for (const v of vals) {
      for (let i = 0; i < edges.length - 1; i++) {
        if (v >= edges[i] && (v < edges[i + 1] || i === edges.length - 2)) { counts[i]++; break; }
      }
    }
    return counts;
  }

  /** Config Chart.js "bar" standard. */
  private barCfg(labels: string[], data: number[], colors: string[] | string, opts: any = {}): any {
    // PATCH-LUCA "chart-axis-titles" (richiesta Luca): gli istogrammi ora
    // mostrano le ETICHETTE degli assi. Si passano tramite opts.xTitle
    // (orizzontale, sotto l'asse X) e opts.yTitle (verticale, a sinistra
    // dell'asse Y). Se non fornite, l'asse resta senza titolo (nessun impatto
    // sui grafici che non le usano). Per i grafici a barre ORIZZONTALI
    // (opts.horizontal) i ruoli degli assi sono invertiti: il valore numerico
    // e' sull'asse X, le categorie sull'asse Y.
    // PATCH-LUCA "chart-axis-titles-style" (richiesta Luca): i titoli sono
    // GRIGI come il resto dei grafici (stesso tono delle tick label, #888),
    // leggermente PIU' PICCOLI (10 -> 9) e MENO in grassetto ('600' -> '500').
    const AXIS_TITLE_COLOR = '#888';
    const xTitleCfg = opts.xTitle
      ? { display: true, text: opts.xTitle, color: AXIS_TITLE_COLOR, font: { size: 9, weight: '500' } }
      : { display: false };
    const yTitleCfg = opts.yTitle
      ? { display: true, text: opts.yTitle, color: AXIS_TITLE_COLOR, font: { size: 9, weight: '500' } }
      : { display: false };
    return {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, borderRadius: 3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: opts.horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: opts.tooltip || {} },
        },
        scales: {
          x: { ticks: { color: '#888', font: { size: 9 } }, grid: { color: '#eee' }, beginAtZero: true, title: xTitleCfg },
          y: { ticks: { color: '#888', font: { size: 9 } }, grid: { color: '#eee' }, beginAtZero: true, title: yTitleCfg },
        },
      },
    };
  }

  /** Config Chart.js "doughnut"/"pie" standard. */
  private doughnutCfg(labels: (string | string[])[], data: number[], colors: string[], cutout = '60%'): any {
    const total = data.reduce((a, b) => a + b, 0);
    return {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 1, borderColor: '#fff' }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout,
        plugins: {
          legend: { position: 'right', labels: { color: '#555', font: { size: 10 }, boxWidth: 10, padding: 6 } },
          tooltip: { callbacks: { label: (ctx: any) => {
            const p = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
            return ` ${ctx.label}: ${ctx.parsed} (${p}%)`;
          } } },
        },
      },
    };
  }

  /** Config Chart.js "line" (curva cumulata). */
  private lineCfg(labels: string[], data: number[], color: string, fill = true): any {
    return {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '33',
        fill, tension: 0.25, pointRadius: 2, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#888', font: { size: 9 } }, grid: { color: '#eee' } },
          y: { ticks: { color: '#888', font: { size: 9 } }, grid: { color: '#eee' }, beginAtZero: true, max: 100 },
        },
      },
    };
  }

  // ============================================================
  // PATCH-LUCA "analytics-precomputed-2026-08-28": helper che costruiscono la
  // config Chart.js A PARTIRE dai dati PRECALCOLATI (analytics.charts[cid]),
  // riusando barCfg/doughnutCfg/lineCfg cosi' l'aspetto (colori, assi, tooltip,
  // titoli) resta IDENTICO a prima. Ogni builder chiama prima questi helper;
  // se il dato precalcolato non c'e', ricade nel calcolo storico dai geojson.
  // ============================================================

  /** Bar chart dai dati precalcolati per 'cid'. colors/opts identici al FE. */
  private barFromData(cid: string, colors: string[] | string, opts: any = {}): any | null {
    const d = this.chartData(cid);
    if (!d || !Array.isArray(d.data)) return null;
    return this.barCfg(d.labels, d.data, colors, opts);
  }

  /** Doughnut chart dai dati precalcolati per 'cid'. */
  private doughnutFromData(cid: string, colors: string[], cutout = '60%'): any | null {
    const d = this.chartData(cid);
    if (!d || !Array.isArray(d.data)) return null;
    return this.doughnutCfg(d.labels, d.data, colors, cutout);
  }

  /** Line chart dai dati precalcolati per 'cid'. */
  private lineFromData(cid: string, color: string): any | null {
    const d = this.chartData(cid);
    if (!d || !Array.isArray(d.data)) return null;
    return this.lineCfg(d.labels, d.data, color);
  }

  /** Costruisce la definizione delle sezioni (chiamata una volta, in ngAfterViewInit). */
  private defineChartSections(): void {
    const self = this;
    this.chartSections = [
      // ============ 1) TRANSPORT (poligoni 15-min, transport_stop = minuti) ============
      {
        id: 'transport', title: '', subtitle: '',
        charts: [
          // PATCH-LUCA "remove-walking-time-distribution-2026-09-09" (richiesta
          // Luca): grafico "Walking time distribution" (id 'dist') RIMOSSO.
          { id: 'zones', title: 'Accessibility zones', sub: '% of grid cells by accessibility level',
            info: 'WHAT: the city split into four accessibility zones by walking distance to transit.\n\nHOW TO READ: each slice is the share of cells in that zone. A large green slice means most of the city is within a short walk of a stop.\n\nCALCULATION: cells are grouped into <15, 15–30, 30–60 and >60 min; the ring shows their percentages of the total.\n\nDATA: transport_15min.geojson — property "transport_stop".',
            build: () => {
            const pre = self.doughnutFromData('transport__zones',
              ['#22c55e', '#eab308', '#ef4444', '#9ca3af']);
            if (pre) return pre;
            const v = self.nums('polygons', 'transport_stop', true);
            const c = self.binCounts(v, [0, 15, 30, 60, Infinity]);
            return self.doughnutCfg(['< 15 min', '15–30 min', '30–60 min', '> 60 min'], c,
              ['#22c55e', '#eab308', '#ef4444', '#9ca3af']);
          }},
          { id: 'cumul', title: 'Cumulative accessibility', sub: '% of area reachable within X minutes',
            info: 'WHAT: the "accessibility curve" — the share of the city reachable within an increasing walking budget.\n\nHOW TO READ: read the % on the Y axis for a given minute budget on the X axis. A curve that rises fast and flattens high means transit is well distributed.\n\nCALCULATION: for each threshold (5,10,…,60 min) we count the cells with walking time ≤ threshold and divide by the total number of cells.\n\nDATA: transport_15min.geojson — property "transport_stop".',
            build: () => {
            // PATCH-LUCA "analytics-precomputed-cumul-fix-2026-08-28": prima
            // questo builder usava SOLO il ramo live (nums('polygons',...)), ma
            // transport_15min.geojson NON viene piu' fetchato in
            // preloadAllChartData -> dataCache['polygons'] vuoto -> grafico
            // vuoto/invisibile. Ora leggo i dati PRECALCOLATI da analytics.json
            // (chiave 'transport__cumul', prodotta dallo step 08e), con
            // fallback al calcolo live se il file non e' disponibile.
            // PATCH-LUCA "cumul-tooltip-abs-count-2026-08-09" (richiesta Luca):
            // il tooltip del grafico, oltre alla % gia' mostrata, riporta la
            // FREQUENZA ASSOLUTA di celle raggiungibili entro quel budget di
            // minuti (es. "5 min -> 64%" e sotto "N celle"). Il grafico continua
            // a leggere i dati PRECALCOLATI (transport__cumul = percentuali); il
            // conteggio celle si ricava moltiplicando la % per il TOTALE CELLE.
            // Il totale celle piu' affidabile e' la somma dei conteggi assoluti
            // del grafico 'transport__zones' ([11252,1337,667,215] = 13471);
            // fallback: conteggio live dei poligoni (nums('polygons',...)).
            const cumData = self.chartData('transport__cumul');
            // Totale celle: da transport__zones (conteggi assoluti) o live.
            let totalCells = 0;
            const zData = self.chartData('transport__zones');
            if (zData && Array.isArray(zData.data)) {
              totalCells = zData.data.reduce((a: number, b: number) => a + (Number(b) || 0), 0);
            }
            if (!totalCells) {
              totalCells = self.nums('polygons', 'transport_stop', true).length;
            }
            // Callback tooltip condiviso: 1a riga = "<label>: <pct>%",
            // 2a riga = "~<n> cells" (frequenza assoluta stimata dalla %).
            const cumTooltip = {
              label: (ctx: any) => {
                const pct = Number(ctx.parsed?.y ?? ctx.parsed ?? 0);
                const cells = Math.round(pct / 100 * totalCells);
                const cellsTxt = cells.toLocaleString('en-US');
                return [` ${ctx.label}: ${pct}%`, ` ~${cellsTxt} cells`];
              },
            };
            if (cumData && Array.isArray(cumData.data)) {
              const cfg = self.lineCfg(cumData.labels, cumData.data, '#7c3aed');
              // Inietto il callback tooltip senza toccare lineCfg (condiviso).
              cfg.options = cfg.options || {};
              cfg.options.plugins = cfg.options.plugins || {};
              cfg.options.plugins.tooltip = { callbacks: cumTooltip };
              return cfg;
            }
            // Fallback: calcolo live delle percentuali + conteggi celle.
            const v = self.nums('polygons', 'transport_stop', true).sort((a, b) => a - b);
            const n = v.length || 1;
            if (!totalCells) totalCells = n;
            const thresholds = [5, 10, 15, 20, 30, 45, 60];
            const cum = thresholds.map(t => +(v.filter(x => x <= t).length / n * 100).toFixed(1));
            const cfgLive = self.lineCfg(thresholds.map(t => t + 'm'), cum, '#7c3aed');
            cfgLive.options = cfgLive.options || {};
            cfgLive.options.plugins = cfgLive.options.plugins || {};
            cfgLive.options.plugins.tooltip = { callbacks: cumTooltip };
            return cfgLive;
          }},
          // PATCH-LUCA "move-deserts-charts-to-transport-2026-09-08" (richiesta
          // Luca): i due grafici che prima stavano nella sezione 'deserts' sono
          // stati SPOSTATI qui, subito SOTTO 'zones' e 'cumul'.
          // PATCH-LUCA "swap-desdist-desserved-2026-09-09" (richiesta Luca):
          // l'ORDINE dei due grafici e' stato SCAMBIATO di NUOVO: ora prima
          // "Underserved residents" (desDist), poi "Covered vs uncovered"
          // (desServed).
          
          { id: 'desDist', title: 'Transit desert', sub: 'desert areas by population size',
            info: 'WHAT: how "transit desert" areas break down by how many residents each one strands.\n\nHOW TO READ: bars on the right are the biggest deserts by population — the priority areas to fix first.\n\nCALCULATION: desert cells are binned by their "pop" (resident) value into bands (1–2, 3–5, 6–10, 11–20, 21+) and counted per band.\n\nDATA: transit_deserts.geojson — property "pop".',
            build: () => {
            // PATCH-LUCA "desdist-show-bars-2026-09-08" (richiesta Luca): prima il
            // builder usava SOLO il ramo live self.nums('deserts','pop'); ma
            // 'deserts' NON e' piu' fetchato come dataset pesante in
            // preloadAllChartData -> array vuoto -> ISTOGRAMMA SENZA BARRE.
            // Ora leggo prima i dati PRECALCOLATI da analytics.json
            // (chiave 'deserts__desDist' = [543,510,562,577,916]) col ramo
            // barFromData, con fallback al calcolo live dai geojson.
            const pre = self.barFromData('deserts__desDist',
              ['#fca5a5', '#f87171', '#ef4444', '#dc2626', '#991b1b'],
              { xTitle: 'Residents per desert area', yTitle: 'Number of desert areas', tooltip: { label: (ctx: any) => ` ${ctx.parsed.y} desert areas` } });
            if (pre) return pre;
            const v = self.nums('deserts', 'pop');
            const c = self.binCounts(v, [1, 3, 6, 11, 21, Infinity]);
            return self.barCfg(['1–2', '3–5', '6–10', '11–20', '21+'], c,
              ['#fca5a5', '#f87171', '#ef4444', '#dc2626', '#991b1b'],
              { xTitle: 'Residents per desert area', yTitle: 'Number of desert areas', tooltip: { label: (ctx: any) => ` ${ctx.parsed.y} desert areas` } });
          }},
          
                    { id: 'desServed', title: 'Population covered vs uncovered', sub: 'share of residents with vs without service',
            info: 'WHAT: the citywide headline — the share of residents that DO have transit coverage vs those that do NOT.\n\nHOW TO READ: the green slice is the population WITH service (covered); the red slice is the population WITHOUT service (uncovered). The two slices sum to the total population.\n\nCALCULATION: Covered = total pop − uncovered pop; Uncovered = uncovered pop. No distinction is made between transit deserts and other unserved areas.\n\nDATA: analytics.json KPI "Pop tot" and "Pop uncovered".',
            build: () => {
            // PATCH-LUCA "desserved-covered-vs-uncovered-2026-09-08" (richiesta
            // Luca): il grafico passa da 3 FETTE (served / unserved fuori deserti /
            // unserved dentro deserti) a 2 FETTE SEMPLICI, SENZA distinzione tra
            // transit desert e unserved:
            //   - VERDE  = residenti COPERTI   = Pop tot - Pop uncovered
            //   - ROSSO  = residenti SCOPERTI  = Pop uncovered
            // I valori arrivano dai KPI PRECALCOLATI (analytics.json: 'Pop tot' e
            // 'Pop uncovered'), robusti anche se i geojson pesanti non sono
            // fetchati. Fallback: somma live dai dati 'coverage'.
            const kpiNum = (label: string): number | null => {
              const arr = (self as any).analytics && (self as any).analytics.kpi;
              if (!Array.isArray(arr)) return null;
              const hit = arr.find((k: any) => k && k.label === label);
              if (!hit) return null;
              const n = parseFloat(String(hit.value).replace(/[^0-9.\-]/g, ''));
              return isNaN(n) ? null : n;
            };
            const totalKpi = kpiNum('Pop tot');
            const uncovKpi = kpiNum('Pop uncovered');
            let totalPop: number, popUncovered: number;
            if (totalKpi !== null && uncovKpi !== null) {
              totalPop = totalKpi;
              popUncovered = uncovKpi;
            } else {
              totalPop = self.nums('coverage', 'pop').reduce((a, b) => a + b, 0);
              popUncovered = self.nums('coverage', 'pop_uncovered').reduce((a, b) => a + b, 0);
            }
            const covered = Math.max(totalPop - popUncovered, 0);
            const uncovered = Math.max(popUncovered, 0);
            const cfgDesServed = self.doughnutCfg(
              ['Covered', 'Uncovered'],
              [covered, uncovered],
              // PATCH-LUCA "desserved-cutout-match-zones-2026-08-09" (richiesta
              // Luca): l'anello di "Covered vs uncovered" (desServed) deve avere
              // lo STESSO SPESSORE dell'anello di "Accessibility zones" (zones).
              // 'zones' usa doughnutFromData(...) senza cutout esplicito, quindi
              // eredita il DEFAULT '60%' di doughnutCfg. Allineo qui il cutout da
              // '68%' a '60%' (cutout piu' piccolo = anello piu' spesso).
              ['#22c55e', '#ef4444'], '60%');
            // PATCH-LUCA "desserved-leftspace-match-zones-2026-09-09" (richiesta
            // Luca): lo SPAZIO A SINISTRA dell'anello deve essere UGUALE a quello
            // di "Accessibility zones" (zones), preso come riferimento. Il
            // fattore che spostava l'anello a sinistra erano le etichette della
            // legenda desServed ("Covered residents"/"Uncovered residents"), piu'
            // lunghe di quelle di zones. Ora sono accorciate a "Covered"/
            // "Uncovered" e NON si applica piu' alcun override di legenda/padding:
            // desServed eredita ESATTAMENTE lo stesso layout di zones
            // (doughnutFromData/doughnutCfg), quindi l'area di disegno e lo
            // spazio a sinistra coincidono. (Rimossi il maxWidth fisso e il
            // padding custom che alteravano l'allineamento rispetto a zones.)
            return cfgDesServed;
          }},
          
          
          // PATCH-LUCA "remove-kpi-15min-chart": grafico 'The "15-minute" promise'
          // (id 'kpi', "cells within vs beyond 15 min") RIMOSSO su richiesta utente.
          // La sezione 'transport' resta con zones / cumul + desDist / desServed
          // (questi ultimi due spostati qui da 'deserts').
        ],
      },

      // ============ 2) TRANSPORT STOP (373 fermate) ============
      {
        id: 'stops', title: '', subtitle: '',
        charts: [
          { id: 'byLines', title: 'Stops by number of lines', sub: 'how many lines serve each stop',
            info: 'WHAT: how the 373 stops break down by the number of bus lines they serve.\n\nHOW TO READ: most stops have few lines (left bars); the tall right bars would be rare, high-value interchange stops.\n\nCALCULATION: line counts are split into 5 classes using QGIS-style natural breaks (Jenks); the stops in each class are counted.\n\nDATA: stops_clipped.geojson — property "lines_count".',
            build: () => {
            const v = self.nums('stops', 'lines_count').filter((x) => x > 0);
            // PATCH-LUCA "bylines-jenks-2026-09-09" (richiesta Luca): le fasce
            // NON sono piu' fisse ([0,2,3,5,8,inf]) ma calcolate coi NATURAL
            // BREAKS (Jenks) di QGIS a 5 classi sui lines_count reali. L'ULTIMA
            // classe e' "min soglia - max tot" (es. "8 - 14"). Se pochi dati,
            // fallback alle vecchie fasce fisse.
            const jb = (self as any).jenksBreaks(v, 5).map((x: number) => Math.ceil(x));
            if (v.length >= 5 && jb.length >= 4) {
              // 4 break interni -> 5 classi. Soglie strettamente crescenti, >=1.
              let b = jb.slice(0, 4);
              for (let i = 0; i < b.length; i++) { if (i === 0) { if (b[0] < 1) b[0] = 1; } else if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1; }
              const [t1, t2, t3, t4] = b;
              const maxV = Math.ceil(Math.max(...v));
              const lastHi = Math.max(t4 + 1, maxV);
              const rng = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
              const edges = [1, t1 + 1, t2 + 1, t3 + 1, t4 + 1, Infinity];
              const c = self.binCounts(v, edges);
              const labels = [rng(1, t1), rng(t1 + 1, t2), rng(t2 + 1, t3), rng(t3 + 1, t4), `${t4 + 1} - ${lastHi}`];
              return self.barCfg(labels, c,
                ['#d0a8dc', '#b880c9', '#a45db8', '#872faa', '#5b1179'],
                { xTitle: 'Lines serving the stop', yTitle: 'Number of stops', tooltip: { label: (ctx: any) => ` ${ctx.parsed.y} stops` } });
            }
            const c = self.binCounts(v, [0, 2, 3, 5, 8, Infinity]);
            return self.barCfg(['1', '2', '3–4', '5–7', '8+'], c,
              ['#d0a8dc', '#b880c9', '#a45db8', '#872faa', '#5b1179'],
              { xTitle: 'Lines serving the stop', yTitle: 'Number of stops', tooltip: { label: (ctx: any) => ` ${ctx.parsed.y} stops` } });
          }},
          // PATCH-LUCA "remove-terminal-vs-through-2026-09-03" (richiesta Luca):
          // grafico "Terminal vs through" (id 'role') RIMOSSO.
          // PATCH-LUCA "remove-service-mix-at-stops-2026-09-03" (richiesta Luca):
          // grafico "Service mix at stops" (id 'service') RIMOSSO.
          { id: 'topHubs', title: 'Top 10 interchange hubs', sub: 'stops serving the most lines',
            info: 'WHAT: the ten busiest stops (per stop_id), ranked by how many bus lines call at them.\n\nHOW TO READ: longer bars = bigger hubs where transfers are easiest; these are the backbone of the network. The bar label shows the stop name; hover a bar to see its stop_id and the exact number of lines.\n\nCALCULATION: each stop_id is ranked by its "lines_count" (number of lines serving that specific stop_id). The top 10 stop_id are shown as horizontal bars.\n\nDATA: stops_clipped.geojson — properties "name", "stop_id" and "lines_count".',
            // PATCH-LUCA "tophubs-right-of-bylines-2026-09-03" (richiesta Luca):
            // "Top 10 interchange hubs" deve stare A DESTRA di "Stops by number
            // of lines". Tolto wide:true (che lo mandava su una riga intera a
            // parte): ora resta nella colonna di destra, affiancato a byLines.
            tall: true, build: () => {
            // FIX-LUCA "tophubs-per-stopid-tooltip": su richiesta utente il
            // grafico lavora PER stop_id (NON aggregato per nome):
            //   - label (asse y)    = nome fermata
            //   - tooltip (3 righe) = nome fermata / stop_id / numero linee
            // Tengo per ogni barra name + stop_id + n (lines_count del singolo
            // stop_id) e li uso nei callback Chart.js 'title' (nome) e 'label'
            // (righe "Stop ID:" e "Lines:").
            const gj = self.dataCache['stops'];
            const feats: any[] = gj?.features || [];
            const arr = feats.map(f => ({
              name: String(f?.properties?.['name'] ?? '—'),
              stopId: String(f?.properties?.['stop_id'] ?? '—'),
              n: parseInt(f?.properties?.['lines_count'], 10) || 0,
            }))
              .sort((a, b) => b.n - a.n)
              .slice(0, 10);
            // PATCH-LUCA "tophubs-biggest-on-top-2026-09-02c" (richiesta Luca):
            // il maggiore deve stare IN CIMA. Chart.js con indexAxis 'y' disegna
            // il PRIMO elemento in ALTO, quindi NON serve piu' .reverse():
            // l'array e' gia' in ordine DECRESCENTE (max primo = disegnato sopra).
            // FIX-LUCA "tophubs-focus-by-stopid": salvo la mappa index->stop_id
            // (allineata all'ordine delle barre) cosi' al click sul grafico
            // posso evidenziare in mappa SOLO la fermata con QUEL stop_id, non
            // tutte le banchine con lo stesso nome.
            self.topHubsStopIds = arr.map(a => a.stopId);
            const cfg = self.barCfg(arr.map(a => a.name + ' (' + a.stopId + ')'), arr.map(a => a.n),
              '#7a1fa2', { horizontal: true, xTitle: 'Number of lines' });
            cfg.options.plugins.tooltip.callbacks = {
              title: (items: any[]) => arr[items && items.length ? items[0].dataIndex : 0]?.name ?? '',
              label: (ctx: any) => {
                const a = arr[ctx.dataIndex];
                return a ? [`Stop ID: ${a.stopId}`, `Lines: ${a.n}`] : '';
              },
            };
            return cfg;
          }},
        ],
      },

      // ============ 3) TRANSPORT LINES (585 tracciati) ============
      {
        id: 'lines', title: '', subtitle: '',
        charts: [
          // PATCH-LUCA "remove-active-lines-by-hour-2026-09-02" (richiesta Luca):
          // grafico "Active lines by hour" (id 'period') CANCELLATO.
          // PATCH-LUCA "remove-direction-balance-2026-09-02" (richiesta Luca):
          // grafico "Direction balance" (id 'dir') RIMOSSO.
          // PATCH-LUCA "remove-top-destinations-2026-09-02" (richiesta Luca):
          // grafico "Top destinations" (id 'dest') RIMOSSO.
        ],
      },

      // ============ 4) HEATMAP FREQUENCY (frequency per segmento) ============
      {
        id: 'freq', title: '', subtitle: '',
        charts: [
          // PATCH-LUCA "remove-frequency-distribution-2026-09-02" (richiesta Luca):
          // grafico "Frequency distribution" (id 'distFreq') RIMOSSO.
          // PATCH-LUCA "remove-corridor-classes-2026-09-02" (richiesta Luca):
          // grafico "Corridor classes" (id 'classShare') RIMOSSO.
          // PATCH-LUCA "remove-duplicate-freqByPeriod-2026-09-03" (richiesta Luca):
          // c'erano DUE card con lo stesso id 'freqByPeriod' -> stesso data-cid
          // 'freq__freqByPeriod' -> il secondo canvas restava VUOTO (il box senza
          // grafico a destra). Rimossa la PRIMA card duplicata (quella con info
          // "how line segments split..."), lasciando solo la vera "Avg trips per
          // hour" (letta da linesActive) qui sotto.
          { id: 'freqByPeriod', title: 'Avg trips per hour', sub: 'mean number of trips each hour',
            info: 'WHAT: the average number of trips (bus, tram and metro together, no distinction) present in each hour of the day (00:00\u201323:00), on a typical day.\n\nHOW TO READ: taller bars = more trips running that hour. A trip is counted in EVERY hour it is in service, not only the hour it departs: a trip 08:00\u201312:00 counts once in 8, 9, 10, 11 and 12.\n\nCALCULATION: from the raw GTFS feed, for each trip we take its first departure and last arrival and add +1 to every hour the interval spans. Each trip is weighted by the number of real service days it actually runs (respecting calendar.txt and calendar_dates.txt), then the total per hour is DIVIDED by the total number of service days of the feed \u2014 giving the mean trips-per-hour on an average day. GTFS times over 24h are wrapped modulo 24.\n\nDATA: lines_active_by_hour.json \u2014 field "avg_active_trips_per_hour" (24 values), generated by the pipeline (step 08d) from calendar / calendar_dates / trips / stop_times, so it is rebuilt automatically for any city.',
            build: () => {
            // PATCH-LUCA "avg-trips-per-hour-2026-08-25" (richiesta Luca):
            // sostituito il vecchio grafico "Avg frequency by period" (4 periodi,
            // media di 'frequency' delle shape) con la MEDIA GIORNALIERA DI CORSE
            // per ora reale: 24 barre = media corse che partono in ciascuna ora,
            // letta da assets/lines_active_by_hour.json (campo avg_active_trips_per_hour,
    //  con fallback su avg_trips_per_hour se il JSON non e' ancora aggiornato),
            // prodotta in pipeline dai GTFS grezzi -> city-agnostic.
            const data = self.dataCache['linesActive'];
            const avg: number[] = (data && Array.isArray(data.avg_active_trips_per_hour)) ? data.avg_active_trips_per_hour : ((data && Array.isArray(data.avg_trips_per_hour)) ? data.avg_trips_per_hour : []);
            if (!avg.length) return null;
            const labels = avg.map((_v, h) => (h < 10 ? '0' + h : '' + h));
            // Tutte le barre dello stesso colore (viola tema), coerente con
            // l'altro istogramma orario.
            return self.barCfg(labels, avg, '#7a1fa2',
              { xTitle: 'Hour of day', yTitle: 'Avg trips',
                tooltip: { label: (ctx: any) => ` ${ctx.parsed.y} trips avg` } });
          }},
          // PATCH-LUCA "remove-topfreq-chart": grafico 'Top 10 frequency segments'
          // (id 'topFreq') RIMOSSO su richiesta utente. Il numero 'frequency' era
          // ambiguo (trip GTFS cumulati su tutti i calendari del feed, non
          // corse/giorno) e generava fraintendimenti. La sezione 'freq' resta con
          // gli altri 3 grafici (distFreq, classShare, freqByPeriod).
        ],
      },

      // ============ 5) POPULATION COVERAGE (pct_covered) ============
      {
        id: 'coverage', title: '', subtitle: '',
        charts: [
          // PATCH-LUCA "remove-coverage-distribution-2026-09-09" (richiesta Luca):
          // grafico "Coverage distribution" (id 'covDist') RIMOSSO.
          // PATCH-LUCA "remove-well-vs-poorly-served-2026-09-09" (richiesta Luca):
          // grafico "Well vs poorly served" (id 'covShare') RIMOSSO.
        ],
      },

      // ============ 6) TRANSIT DESERTS (pop non servita) ============
      // PATCH-LUCA "move-deserts-charts-to-transport-2026-09-08" (richiesta Luca):
      // i due grafici della sezione 'deserts' — 'desDist' (Underserved residents)
      // e 'desServed' (ora "Covered vs uncovered") — sono stati SPOSTATI nella
      // sezione 'transport', subito SOTTO 'zones' (Accessibility zones) e 'cumul'
      // (Cumulative accessibility). La sezione 'deserts' resta senza grafici.
      {
        id: 'deserts', title: '', subtitle: '',
        charts: [],
      },

      // ============ 7) POPULATION 2025 (GHS-POP celle) — RIMOSSA ============
      // PATCH-LUCA "remove-population-2025-section": l'intera sezione 'pop'
      // (Population 2025) con i grafici 'popDist' (Density distribution) e
      // 'popShare' (Where people live) e' stata RIMOSSA su richiesta utente.
      // I dati 'pop' restano comunque precaricati in dataCache perche' usati
      // dal grafico 'desServed' (Transit deserts) e dalle metriche KPI in testa.
    ];
  }

  // PATCH-LUCA "analytics-precomputed-2026-08-28" (richiesta Luca): KPI e
  // GRAFICI del pannello Analytics NON vengono piu' calcolati a runtime iterando
  // i GeoJSON pesanti (transport_15min 67MB, pop_coverage_map 11MB, line 10MB),
  // ma sono PRECALCOLATI dalla pipeline (step 08e) e serviti come UNICO file
  // leggero: assets/analytics.json (~3 KB). Struttura:
  //   { schema, kpi:[{label,value,unit}...], charts:{ "<sez>__<id>": {labels,data,...} } }
  // In dashboard NON cambia NULLA a video/click: cambiano solo VELOCITA' (i
  // grafici appaiono ISTANTANEI) e il fatto che non si scaricano piu' i geojson
  // pesanti solo per gli analytics.
  private analytics: { kpi?: any[]; kpi_by_mode?: any; charts?: { [cid: string]: any } } | null = null;

  /** Ritorna il blocco { labels, data, ... } precalcolato per un chart-id
   *  (es. 'transport__dist'), o null se non presente. Usato dai builder. */
  private chartData(cid: string): any {
    return (this.analytics && this.analytics.charts && this.analytics.charts[cid]) || null;
  }

  /** Precarica gli analytics precalcolati + i geojson LEGGERI ancora necessari
   *  al click->mappa e alla legenda, poi costruisce i grafici. */
  private preloadAllChartData(): void {
    // Sorgenti da fetchare:
    //   - analytics.json : KPI + dati grafici gia' pronti (sostituisce l'uso
    //     analitico di transport_15min/pop_coverage_map/line/stop/deserts).
    //   - stops/lines    : GeoJSON LEGGERI ancora usati per la mappa e per le
    //     interazioni "click barra grafico -> evidenzia in mappa" (stops__topHubs,
    //     lines__dest) e per la legenda livery data-driven (dataCache['lines']).
    //   - deserts        : leggerissimo (~107KB), tenuto per compatibilita' con
    //     eventuali usi mappa (layer Transit deserts).
    //   - linesActive    : istogrammi orari (Active lines by hour / Avg trips per
    //     hour), gia' precalcolati dallo step 08d (restano invariati).
    // NB: NON si fetchano piu' transport_15min.geojson (67MB) ne'
    //     pop_coverage_map.geojson (11MB): i loro numeri sono in analytics.json.
    const sources: { alias: string; file: string }[] = [
      { alias: 'stops',       file: 'assets/stop.geojson' },
      { alias: 'lines',       file: 'assets/line.geojson' },
      { alias: 'linesActive', file: 'assets/lines_active_by_hour.json' },
    ];
    // Fetch degli analytics precalcolati (KPI + grafici) in parallelo ai geojson.
    const analyticsP = fetch('assets/analytics.json')
      .then(r => (r.ok ? r.json() : null))
      .then(a => { this.analytics = a || null; })
      .catch(() => { this.analytics = null; });

    Promise.all([
      analyticsP,
      ...sources.map(s =>
        fetch(s.file).then(r => (r.ok ? r.json() : null)).then(gj => { this.dataCache[s.alias] = gj; }).catch(() => {}))
    ]).then(() => {
      // Riuso la cache dei poligoni gia' esistente (preloadPolygons) se presente.
      if (!this.dataCache['polygons'] && this.polygonsGeojsonCache) this.dataCache['polygons'] = this.polygonsGeojsonCache;
      // PATCH-LUCA "analytics-precomputed-2026-08-28": le KPI ora arrivano gia'
      // pronte da analytics.json (computeKpiMetrics le legge da li'); niente piu'
      // iterazione di geojson pesanti.
      this.computeKpiMetrics();
      // PATCH-LUCA "legend-data-driven-multicity": ora che dataCache['lines']
      // e' pronto, invalido la cache della legenda livery cosi' al prossimo
      // giro di change-detection il getter LINE_LEGEND la RICALCOLA dai dati
      // reali della citta' caricata (Leuven, Madrid, ...).
      this.invalidateLineLegend();
      // PATCH-LUCA "dynamic-legends-2026-09-02": ora che dataCache['stops'] e'
      // pronto, ricalcolo anche le soglie dinamiche di "number of lines"
      // (quintili sui lines_count reali). Ricalcolo tutto per coerenza.
      this.recomputeDynamicTiers();
      this.cdr.detectChanges();
      this.buildAllCharts();
    });
  }

  /** (Ri)costruisce tutti i grafici di tutte le sezioni sui canvas [data-cid]. */
  private buildAllCharts(): void {
    const ChartLib = (window as any).Chart;
    if (!ChartLib) { window.setTimeout(() => this.buildAllCharts(), 300); return; }

    for (const sec of this.chartSections) {
      for (const ch of sec.charts) {
        const cid = sec.id + '__' + ch.id;
        const canvas = document.querySelector(`canvas[data-cid="${cid}"]`) as HTMLCanvasElement | null;
        if (!canvas) continue;
        let cfg: any = null;
        try { cfg = ch.build(); } catch (e) { cfg = null; }
        if (!cfg) continue;
        if (this.chartInstances[cid]) { this.chartInstances[cid].destroy(); }
        // Font di default coerente col resto della dashboard.
        cfg.options = cfg.options || {};
        // PATCH-LUCA "focus-on-map-multi": la logica di "clicca barra -> mostra
        // in mappa + bottone per tornare" e' stata ESTESA da lines__topLines a
        // TRE grafici a barre orizzontali:
        //   - lines__topLines : label "Line X" -> shapes della linea X
        //   - stops__topHubs  : label = nome fermata -> il punto fermata
        //   - lines__dest     : label = destinazione -> shapes con quella dest
        // Tutti e tre usano lo stesso pattern di click (nearest/intersect \u002B
        // fallback su scala y) e chiamano focusFromChartLabel(cid, label), che
        // instrada verso il tipo giusto di focus (linea per line, fermata per
        // hub, destinazione per dest). Il cursore diventa 'pointer' sopra le
        // barre per suggerire il click.
        const FOCUS_CHARTS = ['lines__topLines', 'stops__topHubs', 'lines__dest'];
        if (FOCUS_CHARTS.indexOf(cid) !== -1) {
          // FIX-LUCA "focus-same-line-always": con getElementsAtEventForMode in
          // modalita' 'index'/intersect:false su barre ORIZZONTALI, Chart.js
          // restituiva SEMPRE lo stesso indice (di solito l'ultimo) a
          // prescindere da dove si cliccava -> tutte le barre aprivano la stessa
          // linea. SOLUZIONE: uso mode 'nearest' con intersect:true, che
          // individua esattamente la barra sotto al cursore. In fallback,
          // calcolo l'indice dalla posizione Y del click sulla scala y.
          cfg.options.interaction = { mode: 'nearest', intersect: true, axis: 'y' };
          cfg.options.onClick = (evt: any, _elements: any[], chart: any) => {
            let idx: number | null = null;
            // 1) tentativo primario: elemento esattamente sotto il cursore
            try {
              const hit = chart.getElementsAtEventForMode(
                evt, 'nearest', { intersect: true }, true
              );
              if (hit && hit.length) idx = hit[0].index;
            } catch (e) { idx = null; }
            // 2) fallback: ricavo l'indice dalla coordinata Y del click sulla
            //    scala categoriale (barre orizzontali -> asse y = categorie).
            if (idx === null) {
              try {
                const yScale = chart.scales?.['y'];
                const rect = chart.canvas.getBoundingClientRect();
                const clientY = evt?.native?.clientY ?? evt?.clientY;
                if (yScale && clientY != null) {
                  const yPix = clientY - rect.top;
                  const val = yScale.getValueForPixel(yPix);
                  if (val != null && !isNaN(val)) {
                    idx = Math.max(0, Math.min(chart.data.labels.length - 1, Math.round(val)));
                  }
                }
              } catch (e) { idx = null; }
            }
            // 3) ultimo fallback: array elements di Chart.js
            if (idx === null && _elements && _elements.length) idx = _elements[0].index;
            if (idx === null) return;
            const label = String(chart?.data?.labels?.[idx] ?? '');
            // IMPORTANTE: Chart.js gira FUORI dalla zona Angular, quindi
            // rientro esplicitamente nella zona con this.zone.run(...) cosi'
            // il change-detection aggiorna il template (bottone *ngIf, ecc).
            if (label) this.zone.run(() => this.focusFromChartLabel(cid, label, idx));
          };
          cfg.options.onHover = (evt: any, elements: any[]) => {
            const tgt = evt?.native?.target as HTMLElement | undefined;
            if (tgt) tgt.style.cursor = elements && elements.length ? 'pointer' : 'default';
          };
        }
        this.chartInstances[cid] = new ChartLib(canvas, cfg);
      }
    }
    this.chartsBuilt = true;
  }

  /** True quando i grafici sono gia' stati costruiti almeno una volta. */
  private chartsBuilt = false;

  // ============================================================
  // PATCH-LUCA "focus-line-on-map":
  // Cliccando una barra del grafico "Top 10 busiest lines" (lines__topLines)
  // la dashboard entra in "FOCUS MODE" su quella linea:
  //   - scrolla velocemente verso l'ALTO fino alla mappa;
  //   - nasconde TEMPORANEAMENTE tutti i layer accesi (e la categoria
  //     Transport se attiva), senza perderne lo stato logico;
  //   - disegna in mappa SOLO le route shapes di quella linea, evidenziate,
  //     e fa un fitBounds su di esse;
  //   - mostra in basso a destra un bottone tondo con freccia giu'.
  // Uscita dal focus:
  //   - premendo il bottone freccia-giu' -> torna al grafico topLines e
  //     RIPRISTINA i layer che c'erano prima;
  //   - oppure semplicemente ri-scrollando la mappa via verso il basso ->
  //     ripristina comunque i layer precedenti (senza forzare lo scroll,
  //     visto che lo sta gia' facendo l'utente).
  // ============================================================

  /** True mentre e' attivo il focus su una singola linea. */
  focusActive = false;
  /** Numero/label della linea attualmente in focus (per il tooltip del bottone). */
  focusLine: string | null = null;
  /** Layer Leaflet temporaneo con le sole shapes della linea in focus. */
  private focusLineLayer: L.GeoJSON | null = null;
  /** Snapshot dei layer che erano accesi prima del focus (per ripristinarli). */
  private focusSavedLayers: string[] = [];
  /** Snapshot della categoria Transport attiva prima del focus (''=nessuna). */
  private focusSavedCategory = '';
  /** Guardia: evita che lo scroll-listener di uscita si riattivi durante il ripristino. */
  private focusExiting = false;
  /**
   * PATCH-LUCA "focus-on-map-multi": cid del grafico che ha ORIGINATO il focus
   * attuale ('lines__topLines' | 'stops__topHubs' | 'lines__dest'), cosi' al
   * ritorno (onFocusBackToChart) scrollo esattamente sul grafico giusto e non
   * sempre su topLines.
   */
  private focusSourceCid: string = 'lines__topLines';
  /**
   * FIX-LUCA "tophubs-focus-by-stopid": mappa index->stop_id delle 10 barre del
   * grafico "Top 10 interchange hubs", popolata nel suo builder. Serve per
   * evidenziare in mappa SOLO la fermata con quel preciso stop_id al click.
   */
  private topHubsStopIds: string[] = [];
  /**
   * FIX-LUCA "focus-selfscroll-exits": timestamp (ms) fino al quale gli eventi
   * di scroll su .map-col devono essere IGNORATI da onMapColScroll.
   * CAUSA del bug: entrando in focus si fa col.scrollTo({top:0}); questo scroll
   * PROGRAMMATICO (animato) attraversa valori scrollTop > 80 e faceva scattare
   * subito exitFocus(false), annullando il focus appena entrato. Con questa
   * guardia temporale gli scroll auto-generati dall'entrata non contano come
   * "l'utente sta scrollando via", mentre uno scroll VERO dell'utente (dopo la
   * finestra) esce regolarmente dal focus.
   */
  private focusIgnoreScrollUntil = 0;



  // ============================================================
  // PATCH-LUCA "focus-line-on-map": logica del FOCUS MODE su una linea.
  // ============================================================

  /**
   * Entra in focus mode sulla linea `line`:
   *  1. scrolla velocemente verso l'alto fino alla mappa;
   *  2. salva e nasconde temporaneamente i layer accesi (+ categoria);
   *  3. disegna in mappa SOLO le shapes di quella linea, evidenziate;
   *  4. fitBounds sulle shapes;
   *  5. mostra il bottone freccia-giu' in basso a destra.
   */
  private focusLineOnMap(line: string): void {
    const gj = this.dataCache['lines'];
    const feats: any[] = (gj && Array.isArray(gj.features)) ? gj.features : [];
    // Filtro le sole shapes di questa linea (confronto come stringa trimmata).
    const target = String(line).trim();
    const lineFeats = feats.filter(
      (f) => String(f?.properties?.['line'] ?? '').trim() === target
    );
    if (!lineFeats.length) return; // nessuna geometria: non faccio nulla

    // Se stavo gia' in focus su un'altra linea, ripulisco prima il layer.
    if (this.focusLineLayer) {
      this.map.removeLayer(this.focusLineLayer);
      this.focusLineLayer = null;
    }

    // 1) Se NON ero gia' in focus, salvo lo stato attuale e nascondo i layer.
    if (!this.focusActive) {
      this.focusSavedLayers = Array.from(this.activeLayers);
      this.focusSavedCategory = this.activeCategory;
      // Nascondo (dalla mappa) tutti i layer attualmente in cache SENZA
      // toccare activeLayers / activeCategory (lo stato logico resta intatto,
      // cosi' al ripristino ridisegno esattamente quello che c'era).
      this.layerCache.forEach((lyr) => {
        if (this.map.hasLayer(lyr)) this.map.removeLayer(lyr);
      });
    }

    this.focusActive = true;
    this.focusLine = target;

    // 3) Disegno le shapes della linea in focus, evidenziate (viola Deda spesso).
    //    Uso lo stopsPane (z-index 430) invece del linesPane, cosi' la linea in
    //    focus sta SEMPRE sopra ogni altro layer e si vede bene colorata.
    const focusGeojson = { type: 'FeatureCollection', features: lineFeats } as any;
    this.focusLineLayer = L.geoJSON(focusGeojson, {
      pane: 'linesPane',
      // FIX-LUCA "focus-line-missing-parts": il precedente renderer SVG dedicato
      // ancorato a stopsPane (L.svg({pane:'stopsPane'})) NON ridisegnava alcune
      // porzioni delle MultiLineString su pan/zoom: quelle parti sparivano
      // rispetto al layer "Transport lines" (che invece le mostra). CAUSA: un
      // renderer SVG nuovo/custom non viene esteso come il renderer di default
      // e con geometrie estese (65 shapes / 670 sotto-linee per la 41) alcune
      // parti restano fuori dalla superficie SVG. SOLUZIONE: uso il linesPane
      // esistente (z-index 420, gia' usato dalle linee) SENZA renderer custom,
      // cosi' il focus disegna con la stessa infrastruttura del layer normale
      // che funziona. bringToFront() garantisce comunque che stia sopra.
      // PATCH-LUCA "focus-line-original-color": la linea in focus usa il suo
      // COLORE ORIGINALE (livrea De Lijn, property 'color' del geojson, es. la
      // 41 = #A85E24) invece del viola fisso. Uso normalizeColor() come il
      // rendering livery. Se una feature non ha 'color', fallback al viola Deda.
      // PATCH-LUCA "focus-line-thin": su richiesta utente la linea in focus deve
      // apparire SOTTILE come le normali "Transport lines" (weight 2.5), non
      // spessa/enorme. Prima era weight 6 (evidenziato): l'utente lo trova
      // troppo grosso. Allineato a styleForLine livery (weight 2.5, opacity
      // 0.85). bringToFront() garantisce comunque che stia sopra gli altri.
      style: (f: any) => ({
        color: this.normalizeColor((f?.properties && f.properties['color']) || '#7a1fa2'),
        weight: 2.5,
        opacity: 0.85,
        lineJoin: 'round',
        lineCap: 'round',
      }),
      onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, 'heatmap_lines_livery'),
    } as any);
    this.focusLineLayer.addTo(this.map);
    try { this.focusLineLayer.bringToFront(); } catch (e) {}

    // 4) La mappa NON si sposta: l'utente vuole restare esattamente nella
    //    posizione/zoom in cui si trovava. (Niente fitBounds.)

    // 2b) Scrollo velocemente verso l'ALTO fino alla mappa.
    // FIX-LUCA "focus-selfscroll-exits": prima di lanciare lo scroll
    // programmatico apro una finestra (700ms) in cui onMapColScroll ignora gli
    // eventi: cosi' lo scroll auto-generato dal ritorno alla mappa NON viene
    // scambiato per "l'utente scrolla via" e non annulla il focus appena entrato.
    this.focusIgnoreScrollUntil = Date.now() + 700;
    const col = this.getMapCol();
    if (col) col.scrollTo({ top: 0, behavior: 'smooth' });

    // IMPORTANTE: forzo il change-detection cosi' il bottone freccia-giu'
    // (*ngIf="focusActive") compare subito, anche se siamo partiti da un
    // callback Chart.js.
    this.cdr.detectChanges();

    // Leaflet deve ricalcolare le dimensioni dopo lo scroll (la mappa e'
    // tornata a schermo intero). Non faccio pan/zoom: resta dov'era.
    window.setTimeout(() => this.map.invalidateSize({ animate: false, pan: false }), 60);
  }

  /**
   * PATCH-LUCA "focus-on-map-multi": ROUTER del focus. Dato il cid del grafico
   * cliccato e la label della barra, instrada verso il tipo di focus giusto:
   *   - lines__topLines : "Line 12" -> focusLineOnMap('12')  (shapes linea)
   *   - stops__topHubs  : "<nome fermata>" -> focusStopOnMap(nome) (punto)
   *   - lines__dest     : "<destinazione>" -> focusDestinationOnMap(dest)
   * Salva il cid sorgente per lo scroll di ritorno.
   */
  private focusFromChartLabel(cid: string, label: string, idx?: number): void {
    this.focusSourceCid = cid;
    if (cid === 'lines__topLines') {
      const line = label.replace(/^\s*Line\s*/i, '').trim();
      if (line) this.focusLineOnMap(line);
    } else if (cid === 'stops__topHubs') {
      // FIX-LUCA "tophubs-focus-by-stopid": uso lo stop_id della barra cliccata
      // (via index) per evidenziare in mappa SOLO quella fermata, non tutte le
      // banchine con lo stesso nome. Se per qualche motivo lo stop_id non c'e',
      // ripiego sul vecchio comportamento per nome.
      const stopId = (idx != null) ? this.topHubsStopIds[idx] : undefined;
      if (stopId) this.focusStopByIdOnMap(stopId, label.trim());
      else this.focusStopOnMap(label.trim());
    } else if (cid === 'lines__dest') {
      this.focusDestinationOnMap(label.trim());
    }
  }

  /**
   * PATCH-LUCA "focus-on-map-multi": generalizzazione di focusLineOnMap per
   * DISEGNARE in mappa un sotto-insieme qualsiasi di feature (punti o linee),
   * salvando/nascondendo i layer come nel focus linea e mostrando il bottone
   * di ritorno. \u0060feats\u0060 sono le feature GeoJSON gia' filtrate; \u0060kind\u0060 dice
   * se sono punti (fermata) o linee (shapes), per stile e pane corretti.
   */
  private focusFeaturesOnMap(feats: any[], focusLabel: string, kind: 'point' | 'line'): void {
    if (!feats || !feats.length) return;

    // Se stavo gia' in focus, ripulisco prima il layer temporaneo.
    if (this.focusLineLayer) {
      this.map.removeLayer(this.focusLineLayer);
      this.focusLineLayer = null;
    }

    // Se NON ero gia' in focus, salvo lo stato e nascondo i layer accesi.
    if (!this.focusActive) {
      this.focusSavedLayers = Array.from(this.activeLayers);
      this.focusSavedCategory = this.activeCategory;
      this.layerCache.forEach((lyr) => {
        if (this.map.hasLayer(lyr)) this.map.removeLayer(lyr);
      });
    }

    this.focusActive = true;
    this.focusLine = focusLabel;

    const focusGeojson = { type: 'FeatureCollection', features: feats } as any;
    this.focusLineLayer = L.geoJSON(focusGeojson, {
      pane: kind === 'point' ? 'stopsPane' : 'linesPane',
      // I punti (fermate) diventano marker circolari viola Deda evidenziati,
      // coerenti con lo stile delle fermate ma piu' grandi/marcati per farli
      // spiccare come "risultato" del click sul grafico.
      pointToLayer: (f: any, latlng: any) => L.circleMarker(latlng, {
        pane: 'stopsPane',
        radius: 8,
        color: '#4a0e63',
        weight: 2,
        fillColor: '#7a1fa2',
        fillOpacity: 0.9,
      }),
      // Le linee usano il loro colore livrea originale (come il focus linea).
      style: (f: any) => ({
        color: this.normalizeColor((f?.properties && f.properties['color']) || '#7a1fa2'),
        weight: 2.5,
        opacity: 0.85,
        lineJoin: 'round',
        lineCap: 'round',
      }),
      onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, 'heatmap_lines_livery'),
    } as any);
    this.focusLineLayer.addTo(this.map);
    try { this.focusLineLayer.bringToFront(); } catch (e) {}

    // Per una SINGOLA fermata, centro la mappa su di essa (senza cambiare
    // troppo lo zoom) cosi' l'utente la trova subito; per le linee resto dove
    // sono (come il focus linea esistente).
    if (kind === 'point') {
      try {
        const b = this.focusLineLayer.getBounds();
        if (b && b.isValid()) this.map.setView(b.getCenter(), Math.max(this.map.getZoom(), 15), { animate: false });
      } catch (e) {}
    }

    // Scrollo verso l'alto fino alla mappa (con la stessa guardia anti-uscita).
    this.focusIgnoreScrollUntil = Date.now() + 700;
    const col = this.getMapCol();
    if (col) col.scrollTo({ top: 0, behavior: 'smooth' });

    this.cdr.detectChanges();
    window.setTimeout(() => this.map.invalidateSize({ animate: false, pan: false }), 60);
  }

  /**
   * PATCH-LUCA "focus-on-map-multi": focus su una FERMATA (grafico
   * "Top 10 interchange hubs"). Filtra dal geojson 'stops' la feature con
   * property 'name' uguale al nome cliccato e la evidenzia in mappa.
   */
  private focusStopOnMap(name: string): void {
    const gj = this.dataCache['stops'];
    const feats: any[] = (gj && Array.isArray(gj.features)) ? gj.features : [];
    const target = String(name).trim();
    const hit = feats.filter(
      (f) => String(f?.properties?.['name'] ?? '').trim() === target
    );
    this.focusFeaturesOnMap(hit, target, 'point');
  }

  /**
   * FIX-LUCA "tophubs-focus-by-stopid": focus su una SINGOLA fermata identificata
   * dal suo stop_id (usato dal grafico "Top 10 interchange hubs"). A differenza
   * di focusStopOnMap (che filtra per nome ed evidenzia TUTTE le banchine con
   * quel nome), qui filtro per 'stop_id' cosi' in mappa si accende SOLO il punto
   * cliccato. focusLabel = nome mostrato nel bottone di ritorno.
   */
  private focusStopByIdOnMap(stopId: string, focusLabel: string): void {
    const gj = this.dataCache['stops'];
    const feats: any[] = (gj && Array.isArray(gj.features)) ? gj.features : [];
    const target = String(stopId).trim();
    const hit = feats.filter(
      (f) => String(f?.properties?.['stop_id'] ?? '').trim() === target
    );
    this.focusFeaturesOnMap(hit, focusLabel, 'point');
  }

  /**
   * PATCH-LUCA "focus-on-map-multi" + FIX-LUCA "dest-focus-terminals":
   * focus su una DESTINAZIONE (grafico "Top destinations", where lines terminate).
   * L'utente NON vuole vedere colorate le LINEE, ma i CAPOLINEA (i punti dove
   * le linee terminano). Quindi:
   *   1. dal geojson 'lines' prendo tutte le shapes con quella 'destination' e
   *      ricavo l'ULTIMO punto (fine tracciato) di ciascuna = coordinata di
   *      arrivo/capolinea;
   *   2. costruisco delle feature Point su quei capolinea e le evidenzio in
   *      mappa come marker (kind 'point'), senza disegnare le linee.
   * In fallback, se non riesco a estrarre i punti dalle geometrie, provo a
   * evidenziare le fermate capolinea (stops con is_terminal='yes') il cui nome
   * coincide con la destinazione.
   */
  private focusDestinationOnMap(dest: string): void {
    const gjLines = this.dataCache['lines'];
    const lineFeats: any[] = (gjLines && Array.isArray(gjLines.features)) ? gjLines.features : [];
    const target = String(dest).trim();

    // 1) Shapes che TERMINANO in questa destinazione.
    const shapes = lineFeats.filter(
      (f) => String(f?.properties?.['destination'] ?? '').trim() === target
    );

    // 2) Per ogni shape estraggo l'ULTIMO vertice della geometria = capolinea.
    //    Gestisco LineString e MultiLineString. Deduplico i punti coincidenti
    //    (piu' shapes finiscono spesso nello stesso capolinea).
    const seen = new Set<string>();
    const termFeats: any[] = [];
    for (const f of shapes) {
      const endPt = this.lastCoordOf(f?.geometry);
      if (!endPt) continue;
      const key = endPt[0].toFixed(5) + ',' + endPt[1].toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      termFeats.push({
        type: 'Feature',
        properties: { name: target, destination: target, terminal: 'yes' },
        geometry: { type: 'Point', coordinates: endPt },
      });
    }

    // Fallback: se non ho ricavato punti dalle geometrie, uso le fermate
    // capolinea (is_terminal='yes') con nome = destinazione.
    if (!termFeats.length) {
      const gjStops = this.dataCache['stops'];
      const stopFeats: any[] = (gjStops && Array.isArray(gjStops.features)) ? gjStops.features : [];
      const hit = stopFeats.filter(
        (f) => String(f?.properties?.['name'] ?? '').trim() === target
          && String(f?.properties?.['is_terminal'] ?? '').trim().toLowerCase() === 'yes'
      );
      this.focusFeaturesOnMap(hit, target, 'point');
      return;
    }

    this.focusFeaturesOnMap(termFeats, target, 'point');
  }

  /**
   * FIX-LUCA "dest-focus-terminals": ritorna l'ultima coordinata [lon,lat] di
   * una geometria LineString o MultiLineString (= punto di arrivo/capolinea).
   * Ritorna null per geometrie non gestite o vuote.
   */
  private lastCoordOf(geom: any): [number, number] | null {
    if (!geom) return null;
    try {
      if (geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length) {
        const c = geom.coordinates[geom.coordinates.length - 1];
        return [c[0], c[1]];
      }
      if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates) && geom.coordinates.length) {
        const lastLine = geom.coordinates[geom.coordinates.length - 1];
        if (Array.isArray(lastLine) && lastLine.length) {
          const c = lastLine[lastLine.length - 1];
          return [c[0], c[1]];
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Handler del bottone freccia-giu' in mappa: esce dal focus e TORNA al
   * grafico di origine ripristinando i layer precedenti.
   */
  onFocusBackToChart(): void {
    this.exitFocus(true);
  }

  /**
   * Esce dal focus mode:
   *  - rimuove il layer temporaneo della linea;
   *  - ri-aggiunge alla mappa i layer che erano accesi prima (dallo snapshot);
   *  - se scrollBackToChart === true, scrolla fino al grafico topLines.
   */
  private exitFocus(scrollBackToChart: boolean): void {
    if (!this.focusActive || this.focusExiting) return;
    this.focusExiting = true;

    // Rimuovo il layer della linea in focus.
    if (this.focusLineLayer) {
      this.map.removeLayer(this.focusLineLayer);
      this.focusLineLayer = null;
    }

    // Ri-aggiungo alla mappa i layer che erano accesi prima del focus.
    // activeLayers / activeCategory non sono mai stati modificati, quindi mi
    // basta ri-attaccare i layer gia' in cache (che erano solo stati nascosti).
    for (const id of this.focusSavedLayers) {
      const lyr = this.layerCache.get(id);
      if (lyr && !this.map.hasLayer(lyr)) lyr.addTo(this.map);
    }
    // Categoria Transport (poligoni 15-min): stesso trattamento.
    if (this.focusSavedCategory) {
      const poly = this.layerCache.get('transport_15min');
      if (poly && !this.map.hasLayer(poly)) poly.addTo(this.map);
    }

    this.focusActive = false;
    this.focusLine = null;
    this.focusSavedLayers = [];
    this.focusSavedCategory = '';

    if (scrollBackToChart) {
      // PATCH-LUCA "focus-on-map-multi": scrollo fino al canvas del grafico
      // che ha ORIGINATO il focus (topLines / topHubs / dest), non sempre
      // topLines.
      const canvas = document.querySelector(
        `canvas[data-cid="${this.focusSourceCid}"]`
      ) as HTMLElement | null;
      if (canvas) {
        canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    this.map.invalidateSize({ animate: false, pan: false });

    // Rilascio la guardia poco dopo, quando lo scroll si e' stabilizzato.
    window.setTimeout(() => { this.focusExiting = false; }, 400);
  }

  /**
   * Scroll-listener sulla colonna mappa+grafici: se sono in focus e l'utente
   * scrolla la mappa via verso il basso (scrollTop supera una soglia), esco
   * dal focus ripristinando i layer, SENZA forzare lo scroll (lo sta gia'
   * facendo l'utente). Agganciato via (scroll)="onMapColScroll($event)".
   */
  onMapColScroll(ev: Event): void {
    if (!this.focusActive || this.focusExiting) return;
    // FIX-LUCA "focus-selfscroll-exits": ignora gli eventi di scroll generati
    // dallo scroll programmatico di entrata in focus (finestra temporale).
    if (Date.now() < this.focusIgnoreScrollUntil) return;
    const el = ev.target as HTMLElement;
    // Soglia: quando la mappa e' scrollata via di oltre 80px consideriamo
    // che l'utente sia "andato giu'" verso i grafici.
    if (el && el.scrollTop > 80) {
      this.exitFocus(false);
    }
  }

  /** Ritorna l'elemento .map-col (contenitore mappa + pannello). */
  private getMapCol(): HTMLElement | null {
    return document.querySelector('.map-col') as HTMLElement | null;
  }

  /**
   * PATCH-LUCA "charts-scroll-native":
   * Applica una nuova altezza VISIBILE della mappa (--charts-h controlla quanto
   * ALTO e' #map = 100vh - 52 - (colH - chartsVisible)... in pratica --charts-h
   * = quanto della sezione grafici e' gia' visibile senza scrollare).
   * Trascinando l'handle verso l'ALTO si mostra piu' pannello (mappa piu' bassa);
   * verso il BASSO si mostra piu' mappa. Lo SCROLL vero (mappa che sale, grafici
   * che compaiono) e' quello nativo di .map-col: qui regoliamo solo il "punto di
   * partenza". chartsHeight = quanti px di sezione grafici sono visibili subito.
   */
  private applyChartsHeight(h: number): void {
    const col = this.getMapCol();
    const colH = col ? col.clientHeight : window.innerHeight;
    // chartsHeight = px di sezione grafici visibili sopra la piega.
    // Clamp: la mappa non scende mai sotto MIN_MAP_H, il pannello parte da almeno MIN_PANEL_H.
    const maxH = Math.max(this.CHARTS_MIN_PANEL_H, colH - this.CHARTS_MIN_MAP_H);
    this.chartsHeight = Math.max(this.CHARTS_MIN_PANEL_H, Math.min(maxH, h));
    // --charts-h = altezza dell'area grafici visibile => #map alto = colH - charts-h.
    if (col) {
      col.style.setProperty('--charts-h', this.chartsHeight + 'px');
    }
    // Leaflet deve ricalcolare le dimensioni della mappa (evita tile tagliate).
    if (this.map) {
      this.map.invalidateSize({ animate: false, pan: false });
    }
  }

  /** Inizio drag (mouse o touch) sull'handle. */
  startChartsResize(ev: MouseEvent | TouchEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.chartsDragging = true;
    document.body.classList.add('charts-resizing');
  }

  /** Muove il pannello in base alla Y del cursore (il pannello cresce verso l'alto). */
  private chartsOnMove(clientY: number): void {
    const col = this.getMapCol();
    if (!col) return;
    const rect = col.getBoundingClientRect();
    // Altezza pannello = distanza tra la Y del cursore e il fondo di .map-col.
    const newH = rect.bottom - clientY;
    this.chartsPendingH = newH;
    if (this.chartsRafId != null) return;
    this.chartsRafId = requestAnimationFrame(() => {
      this.chartsRafId = null;
      if (this.chartsPendingH != null) {
        this.applyChartsHeight(this.chartsPendingH);
        this.chartsPendingH = null;
      }
    });
  }

  @HostListener('document:mousemove', ['$event'])
  onChartsMouseMove(ev: MouseEvent): void {
    if (!this.chartsDragging) return;
    this.chartsOnMove(ev.clientY);
  }

  @HostListener('document:touchmove', ['$event'])
  onChartsTouchMove(ev: TouchEvent): void {
    if (!this.chartsDragging || !ev.touches.length) return;
    ev.preventDefault();
    this.chartsOnMove(ev.touches[0].clientY);
  }

  @HostListener('document:mouseup')
  @HostListener('document:touchend')
  endChartsResize(): void {
    if (!this.chartsDragging) return;
    this.chartsDragging = false;
    document.body.classList.remove('charts-resizing');
    // Un ultimo invalidateSize per sicurezza a fine drag.
    if (this.map) {
      this.map.invalidateSize({ animate: false, pan: false });
    }
  }

  /** Re-clamp dell'altezza pannello al resize della finestra. */
  @HostListener('window:resize')
  onWindowResizeCharts(): void {
    this.applyChartsHeight(this.chartsHeight);
  }

  // ============================================================
  // PATCH-LUCA "charts-scroll-native":
  // Lo scroll della sezione grafici e' NATIVO (overflow-y:auto su .map-col):
  // mettendo il cursore sopra mappa+grafici e scrollando giu', la mappa scorre
  // via verso l'alto e salgono i grafici (esattamente come nell'esempio
  // dashboard_embedded.html). Nessun handler wheel custom: il vecchio
  // onChartsWheel/attachChartsWheel e' stato RIMOSSO. La sidebar (aside) ha il
  // suo overflow indipendente e resta ferma.
  // ============================================================

  /**
   * PATCH-LUCA "preload-polygons-no-lag":
   * Scarica una sola volta il GeoJSON dei poligoni Transport e lo tiene in
   * this.polygonsGeojsonCache SENZA aggiungerlo alla mappa. Chiamato all'avvio.
   */
  private preloadPolygons(): void {
    if (this.polygonsGeojsonCache || this.polygonsPreloading) return;
    const cfg = this.layers.find((x) => x.id === 'transport_15min');
    if (!cfg) return;
    this.polygonsPreloading = true;
    fetch(cfg.file)
      .then((r) => (r.ok ? r.json() : null))
      .then((gj) => {
        this.polygonsGeojsonCache = gj;
        // PATCH-LUCA "charts-sections-per-button": popolo anche la cache grafici
        // (alias 'polygons') e ricostruisco i grafici se gia' definiti.
        if (gj) this.dataCache['polygons'] = gj;
        if (this.chartSections.length) this.buildAllCharts();
      })
      .catch(() => { /* se fallisce, loadLayer rifara' il fetch al click */ })
      .finally(() => { this.polygonsPreloading = false; });
  }

  ngOnDestroy(): void {
    // PATCH-LUCA "map-ctrl-wheel-zoom-2026-08-05": rimuovo il listener wheel
    // (ctrl+wheel -> zoom mappa) agganciato al container mappa.
    if (this._blockCtrlWheel && this._blockCtrlWheelEl) {
      try { this._blockCtrlWheelEl.removeEventListener('wheel', this._blockCtrlWheel as any); } catch (e) {}
    }
    // PATCH-LUCA "ff-window-level-ctrlwheel-2026-08-05": rimuovo il listener
    // window-level che blocca lo zoom-pagina del browser sul wheel+ctrlKey.
    if ((this as any)._ffBlockPageZoom) {
      try { window.removeEventListener('wheel', (this as any)._ffBlockPageZoom, { passive: false } as any); } catch (e) {}
    }
    // PATCH-LUCA "charts-sections-per-button": distruggo tutte le istanze Chart.js.
    for (const cid of Object.keys(this.chartInstances)) {
      try { this.chartInstances[cid].destroy(); } catch (e) {}
    }
    this.chartInstances = {};
    if (this.map) this.map.remove();
  }

  // ============================================================
  // PATCH-LUCA "stop-schedule-panel" (2026-07-24):
  // Cliccando una FERMATA in mappa si apre un pannello laterale con la
  // TABELLA ORARIA settimanale di quella fermata (stile palina reale):
  //   - selettore SETTIMANA (dalla settimana corrente all'ultima di agosto);
  //   - 3 TAB per tipo di giorno: Feriale (lun-ven) / Sabato / Domenica-festivi;
  //   - per ogni linea + destinazione, la fascia oraria dei passaggi.
  // I dati sono pre-calcolati offline dal feed GTFS De Lijn (stop_times.txt,
  // trips.txt, calendar/calendar_dates) e serviti come assets/stop_schedules.json
  // (per non caricare i ~900MB di stop_times nel browser).
  // Copertura dati: il feed va dal 27/06/2026 al 30/09/2026, quindi TUTTE le
  // settimane richieste (fino all'ultima di agosto) sono coperte.
  // ============================================================

  // PATCH-LUCA "schedule-board-overlay" (2026-07-24, sostituisce "stop-schedule-panel"):
  // Il pannello orari NON e' piu' una lista laterale a destra, ma un OVERLAY
  // GRANDE CENTRATO SOPRA LA MAPPA (stile info-box / tabellone di stazione).
  //   - In alto: settimana attuale con frecce  <  >  per cambiare settimana.
  //   - Sotto: per OGNI linea+direzione che serve la fermata, un vero TABELLONE:
  //       RIGHE    = tutte le fermate del percorso (capolinea partenza -> arrivo),
  //                  con la fermata cliccata EVIDENZIATA (grassetto + sfondo);
  //       COLONNE  = le singole corse, ognuna con l'orario a ciascuna fermata.
  //   - Un tabellone per FERIALE e uno per FESTIVO (sabato + domenica/festivi),
  //     mostrati impilati verticalmente per ogni linea.
  // I dati NON sono piu' un unico megafile: c'e' un indice leggero
  // (stop_boards_index.json, preloadato) + un file per-fermata caricato
  // ON-DEMAND al click (assets/stop_boards/<stop_id>.json).

  /** Indice (meta + elenco fermate con tabellone), preloadato all'avvio. */
  private boardIndex: any = null;
  /** Board della fermata correntemente aperta (caricati on-demand al click). */
  private boardStopData: any = null;

  // PATCH-LUCA "stop-board-per-real-day" (2026-07-27):
  // Board per GIORNO REALE (lun..dom di ogni settimana), calcolati offline dai
  // dati grezzi GTFS (gen_schedules_board_days.py). Il popup NON mostra piu' 3
  // tipi-giorno (feriale/sabato/domenica) ma un SELECT dei 7 giorni della
  // settimana selezionata; i giorni senza servizio sono disabilitati/grigi.
  //   daysIndex     = stop_boards_days_index.json (meta.weeks[i].days = date reali)
  //   daysStopData  = file per-fermata { name, day_map, day_data, day_avail }
  //   scheduleDayIdx= giorno selezionato (0=lun .. 6=dom)
  private daysIndex: any = null;
  private daysStopData: any = null;
  scheduleDayIdx = 0;
  // PATCH-LUCA "per-shape-day-select": ogni TABELLONE (shape = linea+dest) ha il
  // PROPRIO giorno selezionato, indipendente dagli altri. La mappa associa la
  // chiave del gruppo (line||dest) al giorno scelto (0=lun..6=dom). Se una chiave
  // non e' presente, il giorno di default e' il primo disponibile PER QUEL gruppo
  // (preferendo lunedi'). Cambiando il select di uno shape si aggiorna SOLO la
  // sua voce qui, senza toccare gli altri tabelloni.
  perGroupDayIdx: { [key: string]: number } = {};
  /** Nomi giorno (it) dall'indice, es. ["lunedì",...,"domenica"]. */
  scheduleDayNames: string[] = ["lunedì","martedì","mercoledì","giovedì","venerdì","sabato","domenica"];

  // FIX-LUCA "board-getter-memoize": PERFORMANCE. Il getter scheduleBoardGroups
  // e' usato nel template (*ngIf + *ngFor) e quindi Angular lo rieseguiva ad
  // OGNI ciclo di change-detection. Sulle fermate-hub (es. 303059: ~59 board x
  // 30 fermate x 31 corse) questo significava ricostruire decine di migliaia di
  // celle molte volte al secondo -> il main thread restava saturo e la pagina
  // si "inchiodava" subito dopo il click (loading apparentemente infinito).
  // SOLUZIONE: memoizzo il risultato e lo ricalcolo SOLO quando cambia la
  // fermata (id dei dati caricati) o la settimana selezionata. La cache viene
  // invalidata azzerando _boardGroupsCacheKey (in openStopSchedule/close).
  private _boardGroupsCache: any[] = [];
  private _boardGroupsCacheKey: string | null = null;

  // FIX-LUCA "board-render-cap": numero MASSIMO di corse (colonne) renderizzate
  // per singolo tabellone. Le fermate-hub piu' grandi (es. 303124 = 745 KB,
  // 303058/303059 = ~630 KB) hanno tabelloni con decine di fermate x decine di
  // corse: renderizzare 30x60 = 1800 celle per board, per piu' board, genera
  // decine di migliaia di <td> e blocca il browser ("this page is slowing down
  // Firefox"). Cappando le corse a 60 per tabellone il DOM resta leggero e la
  // pagina NON si inchioda piu', mantenendo comunque un'intera giornata di
  // passaggi ben leggibile (60 corse coprono abbondantemente un giorno tipico).
  private readonly MAX_TRIPS_PER_BOARD = 60;

  /** True se l'overlay orari e' aperto. */
  schedulePanelOpen = false;
  /** True mentre si sta caricando il file della fermata. */
  scheduleLoading = false;
  /** Meta della fermata attualmente mostrata. */
  scheduleStop: { id: string; name: string } | null = null;
  /** Elenco settimane disponibili (dal meta dell'indice). */
  scheduleWeeks: { idx: number; label: string; start: string; end: string }[] = [];
  /** Indice settimana selezionata. */
  scheduleWeekIdx = 0;
  /** Periodo di validita' del feed, per la nota informativa. */
  scheduleFeedValid: { start: string; end: string } | null = null;

  /**
   * Precarica assets/stop_boards_index.json (chiamato all'avvio). Popola le
   * settimane disponibili usate dal selettore  <  >  dell'overlay.
   */
  /**
   * PATCH-LUCA "stop-stats-thematize": precarica assets/stop_stats.json
   * (statistiche per fermata: total/daily/hourly/shapes, settimana 0) usate
   * dalle 4 nuove tematizzazioni delle fermate. A caricamento avvenuto, se il
   * layer Transport stop e' gia' in mappa e in una modalita' stat, ri-applica
   * lo stile cosi' i colori compaiono senza dover rifare click.
   */
  private preloadStopStats(): void {
    // PATCH-LUCA "stop-info-only-2026-01-09" (richiesta Luca): i tabelloni orari
    // per-fermata (stop_boards*, stop_stats/stop_week_stats) NON esistono piu'.
    // Al loro posto la pipeline (step 08_gen_stop_info.py) produce UN SOLO file
    // leggero, assets/stop_info.json, con 4 numeri per fermata:
    //   { generated, modes:{...}, stats:{ "<stop_id>": {name, mode, lines,
    //                                     shapes, freq_hourly, weekly_avg} } }
    // Qui lo carico e lo ADATTO alla struttura interna gia' usata dalle
    // tematizzazioni (stopStats[id] = {total, daily, hourly, shapes}) cosi' le
    // opzioni "avg frequency hourly" e "number of shapes" continuano a
    // funzionare SENZA toccare stopVisual/statTier:
    //   hourly = freq_hourly            (frequenza oraria media)
    //   shapes = shapes                 (percorsi distinti)
    //   total  = weekly_avg             (passaggi settimanali medi)
    //   daily  = weekly_avg / 7         (passaggi giornalieri medi)
    // Conservo anche stopInfo (mappa completa) per il popup fermata.
    const url = new URL('assets/stop_info.json', document.baseURI).toString();
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.stats) return;
        this.zone.run(() => {
          this.stopInfo = data.stats;
          const adapted: { [id: string]: { total: number; daily: number; hourly: number; shapes: number } } = {};
          for (const id of Object.keys(data.stats)) {
            const s = data.stats[id] || {};
            const weekly = Number(s.weekly_avg) || 0;
            adapted[id] = {
              total: weekly,
              daily: weekly / 7,
              hourly: Number(s.freq_hourly) || 0,
              shapes: Number(s.shapes) || 0,
            };
          }
          this.stopStats = adapted;
          this.stopStatsLoaded = true;
          // PATCH-LUCA "dynamic-legends-2026-09-02": ora che stopStats e' pronto,
          // ricalcolo le soglie dinamiche (quintili) di total trip e avg
          // frequency hourly dai dati reali; le legende si aggiornano da sole.
          this.recomputeDynamicTiers();
          // Se sto gia' visualizzando una tematizzazione stat, ridipingo.
          if (['trip', 'daily', 'hourly', 'shapes'].indexOf(this.stopThemeMode) !== -1) {
            this.restyleStops();
          }
        });
      })
      .catch((err) => { console.error('[stop-info] errore caricamento', err); });
  }

  /**
   * PATCH-LUCA "stop-freq-full-week-7days-RAW": precarica stop_week_stats.json
   * (metriche di frequenza per settimana calcolate dai dati grezzi GTFS sui 7
   * giorni reali). Se il popup e' gia' aperto, forza un detectChanges cosi' la
   * riga stats si aggiorna appena i dati arrivano.
   */
  private preloadWeekStats(): void {
    const url = new URL('assets/stop_week_stats.json', document.baseURI).toString();
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.stats) return;
        this.zone.run(() => {
          this.weekStats = data.stats;
          this.weekStatsLoaded = true;
          this.cdr.detectChanges();
        });
      })
      .catch((err) => { console.error('[week-stats] errore caricamento', err); });
  }

  private preloadScheduleData(): void {
    const url = new URL('assets/stop_boards_index.json', document.baseURI).toString();
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) { console.error('[orari] index non caricato da', url); return; }
        this.boardIndex = data;
        const meta = data.meta || {};
        this.scheduleWeeks = meta.weeks || [];
        this.scheduleFeedValid = meta.feed_valid || null;
      })
      .catch((err) => { console.error('[orari] errore index', err); /* overlay mostra "dati non disponibili" */ });
  }

  /**
   * PATCH-LUCA "stop-board-per-real-day": precarica stop_boards_days_index.json.
   * Da qui prendo le settimane con le DATE REALI dei 7 giorni (meta.weeks[i].days)
   * e i nomi giorno localizzati (meta.day_names), usati dal SELECT del popup.
   * Se disponibile, uso queste settimane (identiche a quelle dei board classici).
   */
  private preloadDaysIndex(): void {
    const url = new URL('assets/stop_boards_days_index.json', document.baseURI).toString();
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) { console.error('[orari-giorni] index non caricato da', url); return; }
        this.daysIndex = data;
        const meta = data.meta || {};
        if (Array.isArray(meta.day_names) && meta.day_names.length === 7) {
          this.scheduleDayNames = meta.day_names;
        }
        // Le settimane hanno anche il campo .days (7 date reali): riuso queste
        // come sorgente ufficiale delle settimane (sovrascrivo quelle classiche
        // che non hanno .days), cosi' il select ha sempre le date corrette.
        if (Array.isArray(meta.weeks) && meta.weeks.length) {
          this.scheduleWeeks = meta.weeks;
          if (!this.scheduleFeedValid) this.scheduleFeedValid = meta.feed_valid || null;
        }
      })
      .catch((err) => { console.error('[orari-giorni] errore index', err); });
  }

  /**
   * Apre l'overlay orari per una fermata (feature GeoJSON). Carica ON-DEMAND
   * il file assets/stop_boards/<stop_id>.json (solo i tabelloni di QUELLA
   * fermata), poi mostra l'overlay. Chiamato dal click sul marker (in NgZone).
   */
  openStopSchedule(feature: any): void {
    // PATCH-LUCA "stop-info-panel-4numbers" (2026-09-02): il click su una fermata
    // NON carica piu' i tabelloni orari (stop_boards*). Mostra un pannello leggero
    // con i 4 numeri della fermata letti da stopInfo (assets/stop_info.json):
    //   lines / shapes / freq_hourly / weekly_avg.
    // Se stopInfo non e' ancora caricato o la fermata non e' presente, il pannello
    // mostra "no data" (stopInfoView = null).
    const p = feature?.properties || {};
    const id = String(p['stop_id'] ?? '');
    this.scheduleStop = { id, name: String(p['name'] ?? 'Stop') };
    const info = this.stopInfo ? this.stopInfo[id] : null;
    this.stopInfoView = info
      ? {
          lines: Number(info.lines) || 0,
          shapes: Number(info.shapes) || 0,
          freq_hourly: Number(info.freq_hourly) || 0,
          weekly_avg: Number(info.weekly_avg) || 0,
          // PATCH-LUCA "stopinfo-stop-url-2026-10-09" (richiesta Luca): link della
          // fermata (campo stop_url del feed GTFS), mostrato in fondo al pannello.
          stop_url: (info.stop_url != null ? String(info.stop_url).trim() : ''),
          line_list: Array.isArray(info.line_list) ? info.line_list : [],
        }
      : null;
    this.schedulePanelOpen = true;
    this.scheduleLoading = false;
    this.cdr.detectChanges();
  }

  /** Chiude l'overlay orari. */
  closeStopSchedule(): void {
    this.schedulePanelOpen = false;
    this.scheduleStop = null;
    this.boardStopData = null;
    this._boardGroupsCacheKey = null;   // FIX-LUCA "board-getter-memoize": invalido la cache
    this._boardGroupsCache = [];
    this._freqStatsCacheKey = null;     // PATCH-LUCA "stop-frequency-stats": invalido cache stats
  }

  /** Vai alla settimana precedente (freccia  <  ), senza andare sotto 0. */
  prevScheduleWeek(): void {
    if (this.scheduleWeekIdx > 0) {
      this.scheduleWeekIdx--;
      // PATCH-LUCA "stop-board-per-real-day": nuovo giorno di default = primo
      // disponibile della nuova settimana; invalido la cache dei board.
      this.scheduleDayIdx = this.firstAvailableDay(this.scheduleWeekIdx);
      this.perGroupDayIdx = {};  // PATCH-LUCA "per-shape-day-select": nuova settimana -> ricalcolo default per-shape
      this._boardGroupsCacheKey = null;
      this._boardGroupsCache = [];
      // FIX-LUCA "route-strip-center-focus": al cambio settimana le board
      // vengono ricostruite -> ri-centro le barre sulla fermata cliccata
      // (scorrimento morbido). Attendo il render con setTimeout + rAF.
      window.setTimeout(() => requestAnimationFrame(() => this.centerRouteStripsOnFocus(true)), 0);
    }
  }

  /** Vai alla settimana successiva (freccia  >  ), senza superare l'ultima. */
  nextScheduleWeek(): void {
    if (this.scheduleWeekIdx < this.scheduleWeeks.length - 1) {
      this.scheduleWeekIdx++;
      this.scheduleDayIdx = this.firstAvailableDay(this.scheduleWeekIdx);
      this.perGroupDayIdx = {};  // PATCH-LUCA "per-shape-day-select": nuova settimana -> ricalcolo default per-shape
      this._boardGroupsCacheKey = null;
      this._boardGroupsCache = [];
      window.setTimeout(() => requestAnimationFrame(() => this.centerRouteStripsOnFocus(true)), 0);
    }
  }

  /**
   * FIX-LUCA "route-strip-scroll": scorre la barra percorso (viewport della
   * .route-strip che ha piu' di 12 fermate) avanti (dir=1) o indietro (dir=-1).
   * Trova il .route-strip-viewport fratello del bottone cliccato e ne anima lo
   * scrollLeft di ~10 fermate per volta (larghezza di 10 "slot" da 1/12).
   */
  scrollRouteStrip(ev: Event, dir: number): void {
    ev.stopPropagation();
    const btn = ev.currentTarget as HTMLElement;
    const strip = btn?.closest('.route-strip') as HTMLElement | null;
    const vp = strip?.querySelector('.route-strip-viewport') as HTMLElement | null;
    if (!vp) return;
    // avanzo di ~10 fermate per click. Larghezza di una fermata: la leggo dal
    // primo .route-stop (63px in modalita' scroll); fallback a clientWidth/12.
    const firstStop = strip?.querySelector('.route-stop') as HTMLElement | null;
    const slot = firstStop ? firstStop.getBoundingClientRect().width : vp.clientWidth / 12;
    const delta = dir * slot * 10;
    vp.scrollBy({ left: delta, behavior: 'smooth' });
  }

  /**
   * FIX-LUCA "route-strip-center-focus": centra OGNI barra percorso aperta
   * sulla fermata cliccata (.route-stop.focus), cosi' l'utente la vede sempre
   * AL CENTRO della finestra (max 12 fermate visibili) invece che sempre
   * dall'inizio. Con clamp agli estremi:
   *   - se la fermata e' tra le prime (es. 3a): niente spazio vuoto a sinistra,
   *     la barra resta all'inizio (scrollLeft 0);
   *   - se e' tra le ultime (es. penultima): la barra si ferma in fondo,
   *     mostrando le ultime 12 fermate;
   *   - altrimenti la fermata finisce esattamente al centro del viewport.
   * Il clamp e' garantito da scrollWidth/clientWidth (il browser non scrolla
   * comunque oltre i limiti). Chiamato quando l'overlay e' pronto e al cambio
   * settimana; usa un piccolo setTimeout per attendere il render del DOM.
   * smooth=false alla prima apertura (posizionamento immediato), true al
   * cambio settimana (scorrimento morbido).
   */
  private centerRouteStripsOnFocus(smooth = false): void {
    // Le barre esistono solo quando l'overlay e' aperto e ci sono board.
    const viewports = document.querySelectorAll<HTMLElement>('.sched-modal .route-strip-viewport');
    viewports.forEach((vp) => {
      // La fermata evidenziata dentro QUESTA barra.
      const focusEl = vp.querySelector<HTMLElement>('.route-stop.focus');
      if (!focusEl) return;
      // Centro il pallino della fermata nel viewport.
      const target = focusEl.offsetLeft + focusEl.offsetWidth / 2 - vp.clientWidth / 2;
      // Clamp esplicito tra 0 e (scrollWidth - clientWidth): niente spazi vuoti
      // agli estremi (prime/ultime fermate).
      const maxScroll = Math.max(0, vp.scrollWidth - vp.clientWidth);
      const left = Math.max(0, Math.min(maxScroll, target));
      vp.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    });
  }


  /** Etichetta della settimana correntemente selezionata (per l'header). */
  get scheduleWeekLabel(): string {
    const w = this.scheduleWeeks[this.scheduleWeekIdx];
    return w ? w.label : '';
  }

  /** True se la fermata ha almeno un tabellone in QUALSIASI settimana. */
  get scheduleHasAnyData(): boolean {
    // FIX-LUCA "board-dedup-weeks": nuova struttura file per-fermata
    //   { name, week_map:{settimana->idx}, week_data:[ {perDaytype}, ... ] }
    // (le settimane duplicate puntano allo stesso contenuto, file ~68% piu'
    // leggeri, niente piu' timeout in caricamento). Retro-compat con la vecchia
    // chiave "weeks" mantenuta come fallback.
    const d = this.boardStopData;
    if (!d) return this.hasDayBoards && this.daysHaveAnyBoard;
    if (d.week_data) return (Array.isArray(d.week_data) && d.week_data.length > 0) || (this.hasDayBoards && this.daysHaveAnyBoard);
    const weeks = d.weeks;
    return (!!weeks && Object.keys(weeks).length > 0) || (this.hasDayBoards && this.daysHaveAnyBoard);
  }

  /** True se il file board-per-giorno ha almeno un giorno con corse. */
  private get daysHaveAnyBoard(): boolean {
    const d = this.daysStopData;
    if (!d || !d.day_avail) return false;
    return Object.values(d.day_avail).some((v) => !!v);
  }

  // ============================================================
  // PATCH-LUCA "stop-board-per-real-day": SELECT dei 7 giorni della settimana.
  // ============================================================

  // FIX-LUCA "dayselect-getter-memoize": PERFORMANCE. Il getter scheduleDays e'
  // letto dal template dentro *ngFor="let d of scheduleDays" (il <select> dei 7
  // giorni). Un getter che ritorna un ARRAY NUOVO ad ogni chiamata + un *ngFor
  // SENZA trackBy fa ricreare/distruggere le 7 <option> ad OGNI ciclo di
  // change-detection. Con Leaflet che emette mousemove in continuazione (ogni
  // movimento = un ciclo CD), il DOM del select viene rigenerato di continuo e
  // il main thread si satura -> la pagina "carica per un po' poi si blocca".
  // Stesso identico pattern gia' risolto per scheduleBoardGroups (memoize).
  // SOLUZIONE: memoizzo scheduleDays con chiave (fermata#settimana#giorno) e
  // aggiungo trackBy (trackScheduleDay) all'*ngFor nel template.
  private _scheduleDaysCache: { idx: number; label: string; date: string; avail: boolean }[] = [];
  private _scheduleDaysCacheKey: string | null = null;

  /** Lista dei 7 giorni della settimana corrente, con label (nome + data) e
   *  flag di disponibilita' (avail) per abilitare/disabilitare l'opzione.
   *  MEMOIZZATO: ricostruito solo quando cambia fermata / settimana / dati. */
  get scheduleDays(): { idx: number; label: string; date: string; avail: boolean }[] {
    // La disponibilita' (avail) dipende da daysStopData (day_avail), quindi la
    // chiave include anche se il file board-per-giorno e' caricato.
    const key = String(this.scheduleStop?.id ?? '') + '#' + String(this.scheduleWeekIdx) + '#' + (this.hasDayBoards ? '1' : '0');
    if (key === this._scheduleDaysCacheKey) {
      return this._scheduleDaysCache;
    }
    const wk = this.scheduleWeeks[this.scheduleWeekIdx] as any;
    const dates: string[] = (wk && Array.isArray(wk.days)) ? wk.days : ['','','','','','',''];
    const out: { idx: number; label: string; date: string; avail: boolean }[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const name = this.scheduleDayNames[dow] || '';
      const date = dates[dow] || '';
      out.push({ idx: dow, label: date ? `${name} ${date}` : name, date, avail: this.isDayAvailable(this.scheduleWeekIdx, dow) });
    }
    this._scheduleDaysCacheKey = key;
    this._scheduleDaysCache = out;
    return out;
  }

  /** trackBy per l'*ngFor delle <option> del select giorno: l'indice del giorno
   *  (0=lun..6=dom) e' stabile, cosi' Angular RIUSA le option esistenti invece
   *  di distruggerle/ricrearle ad ogni change-detection. */
  trackScheduleDay(_i: number, d: { idx: number }): number { return d.idx; }

  /** True se il giorno (settimana wi, giorno dow) ha almeno una corsa. */
  private isDayAvailable(wi: number, dow: number): boolean {
    const d = this.daysStopData;
    if (!d || !d.day_avail) return false;
    return !!d.day_avail[`${wi}_${dow}`];
  }

  /** Indice del primo giorno disponibile della settimana wi (fallback 0). */
  private firstAvailableDay(wi: number): number {
    for (let dow = 0; dow < 7; dow++) {
      if (this.isDayAvailable(wi, dow)) return dow;
    }
    return 0;
  }

  /** Label "nome + data" del giorno dow nella settimana corrente. */
  private scheduleDayLabelFor(dow: number): string {
    const wk = this.scheduleWeeks[this.scheduleWeekIdx] as any;
    const name = this.scheduleDayNames[dow] || '';
    const date = (wk && Array.isArray(wk.days)) ? (wk.days[dow] || '') : '';
    return date ? `${name} ${date}` : name;
  }

  /** Handler del <select> giorno: cambia giorno e ricostruisce i tabelloni. */
  onSelectDay(ev: Event): void {
    const val = (ev.target as HTMLSelectElement).value;
    const dow = parseInt(val, 10);
    if (isNaN(dow) || dow === this.scheduleDayIdx) return;
    this.scheduleDayIdx = dow;
    this._boardGroupsCacheKey = null;
    this._boardGroupsCache = [];
    window.setTimeout(() => requestAnimationFrame(() => this.centerRouteStripsOnFocus(true)), 0);
  }

  // ============================================================
  // PATCH-LUCA "per-shape-day-select": giorno indipendente per ogni tabellone.
  // ============================================================

  /** Giorno (0=lun..6=dom) attualmente selezionato per il gruppo (shape) key.
   *  Se non impostato esplicitamente, ritorna il primo giorno disponibile PER
   *  QUEL gruppo (preferendo lunedi'). */
  groupDayIdx(key: string): number {
    if (Object.prototype.hasOwnProperty.call(this.perGroupDayIdx, key)) {
      return this.perGroupDayIdx[key];
    }
    return this.firstAvailableDayForGroup(key);
  }

  /** Indice del primo giorno (0=lun..6=dom) in cui il gruppo key ha un board
   *  nella settimana corrente. Preferisce lunedi'; fallback: primo disponibile;
   *  ultimo fallback: 0. */
  private firstAvailableDayForGroup(key: string): number {
    for (let dow = 0; dow < 7; dow++) {
      if (this.groupHasBoardOnDay(key, dow)) return dow;
    }
    return 0;
  }

  /** True se il gruppo (line||dest) circola nel giorno dow della settimana. */
  private groupHasBoardOnDay(key: string, dow: number): boolean {
    const boards = this.dayBoardsForDay(dow);
    for (const b of boards) {
      const k = (b.line || '') + '||' + (b.dest || '');
      if (k === key) return true;
    }
    return false;
  }

  /** Lista board del giorno dow (settimana corrente) da daysStopData. [] se assente. */
  private dayBoardsForDay(dow: number): any[] {
    const d = this.daysStopData;
    if (!d || !d.day_map || !Array.isArray(d.day_data)) return [];
    const idx = d.day_map[`${this.scheduleWeekIdx}_${dow}`];
    if (idx == null) return [];
    const boards = d.day_data[idx];
    return Array.isArray(boards) ? boards : [];
  }

  /** Handler del <select> giorno del SINGOLO tabellone: aggiorna solo la voce
   *  del gruppo key e invalida la cache dei board (ricostruzione mirata). */
  onSelectGroupDay(key: string, ev: Event): void {
    const val = (ev.target as HTMLSelectElement).value;
    const dow = parseInt(val, 10);
    if (isNaN(dow)) return;
    if (this.groupDayIdx(key) === dow) return;
    this.perGroupDayIdx = { ...this.perGroupDayIdx, [key]: dow };
    this._boardGroupsCacheKey = null;
    this._boardGroupsCache = [];
    window.setTimeout(() => requestAnimationFrame(() => this.centerRouteStripsOnFocus(true)), 0);
  }

  /** trackBy per l'*ngFor delle <option> del select-giorno di ogni tabellone. */
  trackGroupDay(_i: number, d: { idx: number }): number { return d.idx; }

  /** Serializzazione STABILE (chiavi ordinate) della mappa perGroupDayIdx, usata
   *  come parte della chiave di memoize di scheduleBoardGroups: cosi' quando
   *  cambio il giorno di UN solo tabellone la cache si invalida correttamente. */
  private perGroupDayKey(): string {
    const keys = Object.keys(this.perGroupDayIdx).sort();
    return keys.map((k) => k + '=' + this.perGroupDayIdx[k]).join(';');
  }

  /**
   * Risolve il contenuto (per-tipo-giorno) della settimana selezionata,
   * gestendo sia la nuova struttura deduplicata (week_map/week_data) sia la
   * vecchia (weeks). Ritorna null se assente.
   */
  private resolveWeekData(): any {
    const d = this.boardStopData;
    if (!d) return null;
    const wi = String(this.scheduleWeekIdx);
    if (d.week_map && Array.isArray(d.week_data)) {
      const idx = d.week_map[wi];
      if (idx == null) return null;
      return d.week_data[idx] ?? null;
    }
    // fallback vecchia struttura
    return d.weeks ? (d.weeks[wi] ?? null) : null;
  }

  /**
   * PATCH-LUCA "stop-board-per-real-day": risolve la LISTA di board del GIORNO
   * REALE selezionato (settimana scheduleWeekIdx, giorno scheduleDayIdx 0=lun).
   * Legge daysStopData (day_map/day_data). Ritorna [] se assente/non disponibile.
   */
  private resolveDayBoards(): any[] {
    const d = this.daysStopData;
    if (!d || !d.day_map || !Array.isArray(d.day_data)) return [];
    const dkey = `${this.scheduleWeekIdx}_${this.scheduleDayIdx}`;
    const idx = d.day_map[dkey];
    if (idx == null) return [];
    const boards = d.day_data[idx];
    return Array.isArray(boards) ? boards : [];
  }

  /** True se la fermata ha il file board-per-giorno caricato. */
  get hasDayBoards(): boolean {
    const d = this.daysStopData;
    return !!(d && d.day_map && Array.isArray(d.day_data));
  }

  /**
   * Ritorna i TABELLONI (board) della settimana selezionata, gia' impilati per
   * linea con la coppia Feriale/Festivo. Ogni elemento del risultato e' una
   * "linea" con fino a 2 tabelloni (feriale, festivo).
   *
   * Struttura di ritorno:
   *   [ { key, line, color, dest,
   *       boards: [ { dayLabel, stops:[{id,name,focus}], trips:[[times]] } ] } ]
   *
   * NOTA "festivo": unisco sabato + domenica/festivi. Se hanno orari diversi,
   * mostro entrambi come due sotto-tabelloni distinti ("Sabato" / "Domenica-festivi");
   * se una linea non circola nel weekend, la sua sezione festiva resta vuota.
   */
  get scheduleBoardGroups(): {
    key: string; line: string; color: string; dest: string;
    dayIdx: number; days: { idx: number; label: string; avail: boolean }[];
    boards: { dayLabel: string; routeStops: any[]; focusIdx: number; stops: any[]; trips: string[][] }[];
  }[] {
    // FIX-LUCA "board-getter-memoize": questo getter e' letto dal template a
    // ogni change-detection. Calcolo la chiave (fermata + settimana): se non e'
    // cambiata restituisco la cache SENZA ricostruire nulla (costo O(1)),
    // evitando il freeze del main thread. Ricostruisco solo quando serve.
    // FIX-LUCA "days-only-no-freeze": finche' i board per giorno reale NON sono
    // ancora caricati (scheduleLoading o !hasDayBoards) NON calcolo nulla:
    // restituisco [] subito. Senza questa guardia, con boardStopData sempre
    // null la chiave restava null e computeBoardGroups veniva rieseguito ad
    // ogni ciclo di change-detection -> pagina che si blocca ("slowing down").
    if (this.scheduleLoading || !this.hasDayBoards) {
      return [];
    }
    const key = (String(this.scheduleStop?.id ?? '') + '#' + String(this.scheduleWeekIdx) + '#' + String(this.scheduleDayIdx) + '#' + this.perGroupDayKey());
    if (key === this._boardGroupsCacheKey) {
      return this._boardGroupsCache;
    }
    this._boardGroupsCacheKey = key;
    this._boardGroupsCache = this.computeBoardGroups();
    return this._boardGroupsCache;
  }

  /** Costruzione EFFETTIVA dei gruppi-linea (chiamata solo quando cambia
   *  fermata/settimana, mai a ripetizione grazie alla memoizzazione). */
  private computeBoardGroups(): {
    key: string; line: string; color: string; dest: string;
    dayIdx: number; days: { idx: number; label: string; avail: boolean }[];
    boards: { dayLabel: string; routeStops: any[]; focusIdx: number; stops: any[]; trips: string[][] }[];
  }[] {
    // PATCH-LUCA "stop-board-per-real-day": se ho i board per GIORNO REALE, uso
    // quelli (il popup mostra il giorno scelto nel select). Altrimenti fallback
    // ai vecchi board per tipo-giorno (weekday/saturday/sunday).
    // PATCH-LUCA "per-shape-day-select": se ho i board per GIORNO REALE, ogni
    // tabellone (shape = linea+dest) mostra il PROPRIO giorno, scelto dal suo
    // select. Costruisco prima l'universo dei gruppi scandendo TUTTI i 7 giorni
    // della settimana (cosi' ogni shape compare anche se non circola nel giorno
    // di default e ottengo, per ciascuno, l'elenco dei giorni disponibili);
    // poi, per ogni gruppo, prendo il suo board dal giorno da lui selezionato.
    if (this.hasDayBoards) {
      const wkSel = this.scheduleWeeks[this.scheduleWeekIdx] as any;
      const dates: string[] = (wkSel && Array.isArray(wkSel.days)) ? wkSel.days : ['', '', '', '', '', '', ''];

      // 1) UNIVERSO dei gruppi: meta (line/dest/color) + giorni disponibili.
      const order: string[] = [];
      const meta: { [k: string]: { line: string; color: string; dest: string; availDays: Set<number> } } = {};
      for (let dow = 0; dow < 7; dow++) {
        const boards = this.dayBoardsForDay(dow);
        for (const b of boards) {
          const key = (b.line || '') + '||' + (b.dest || '');
          if (!meta[key]) {
            meta[key] = { line: b.line, color: b.color, dest: b.dest, availDays: new Set<number>() };
            order.push(key);
          }
          meta[key].availDays.add(dow);
        }
      }

      // 2) Ordino i gruppi per numero di linea (poi alfabetico).
      order.sort((a, b) => {
        const la = meta[a].line, lb = meta[b].line;
        const na = parseInt(String(la).replace(/\D/g, ''), 10);
        const nb = parseInt(String(lb).replace(/\D/g, ''), 10);
        if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
        return String(la).localeCompare(String(lb));
      });

      // 3) Per ogni gruppo: giorno selezionato -> board di QUEL giorno.
      const result = order.map((key) => {
        const m = meta[key];
        // PATCH-LUCA "dayselect-grey-unavailable" (2026-07-28): la select del
        // singolo tabellone mostra TUTTI i 7 giorni; i giorni in cui la shape
        // NON circola restano visibili ma GRIGI/disabilitati (avail=false).
        // Il giorno SELEZIONATO di default e' comunque il primo DISPONIBILE
        // (dayIdx = groupDayIdx -> firstAvailableDayForGroup): se lunedi' non
        // ha servizio, lunedi' resta grigio ma la voce attiva/selezionata e
        // la tabella sono su martedi' (primo giorno con corse).
        const days = [] as { idx: number; label: string; avail: boolean }[];
        for (let dow = 0; dow < 7; dow++) {
          const name = this.scheduleDayNames[dow] || '';
          const date = dates[dow] || '';
          days.push({ idx: dow, label: date ? (name + ' ' + date) : name, avail: m.availDays.has(dow) });
        }
        const dayIdx = this.groupDayIdx(key);
        const dayLabel = this.scheduleDayLabelFor(dayIdx);

        const dayBoardsSel = this.dayBoardsForDay(dayIdx);
        const b = dayBoardsSel.find((x: any) => ((x.line || '') + '||' + (x.dest || '')) === key);

        const boards: { dayLabel: string; routeStops: any[]; focusIdx: number; stops: any[]; trips: string[][] }[] = [];
        if (b) {
          const allStops: any[] = Array.isArray(b.stops) ? b.stops : [];
          let fi = allStops.findIndex((s: any) => s && s.focus);
          if (fi < 0) fi = 0;
          const stopsFrom = allStops.slice(fi);
          const tripsFrom = (Array.isArray(b.trips) ? b.trips : [])
            .map((t: any[]) => (Array.isArray(t) ? t.slice(fi) : []))
            .filter((t: any[]) => t.some((x) => x != null && x !== ''))
            .slice(0, this.MAX_TRIPS_PER_BOARD);
          boards.push({ dayLabel, routeStops: allStops, focusIdx: fi, stops: stopsFrom, trips: tripsFrom });
        }
        return { key, line: m.line, color: m.color, dest: m.dest, dayIdx, days, boards };
      });

      return result;
    }


    const perDt = this.resolveWeekData();
    if (!perDt) return [];

    // Mappa: chiave linea+dest -> gruppo con i suoi tabelloni per tipo-giorno.
    const order: string[] = [];
    const groups: { [k: string]: any } = {};

    const addBoards = (arr: any[], dayLabel: string) => {
      if (!Array.isArray(arr)) return;
      for (const b of arr) {
        const key = (b.line || '') + '||' + (b.dest || '');
        if (!groups[key]) {
          groups[key] = { key, line: b.line, color: b.color, dest: b.dest, boards: [] };
          order.push(key);
        }
        // FIX-LUCA "board-from-focus-onward": l'utente vuole vedere SOLO la
        // tratta dalla fermata cliccata (focus) al capolinea, NON le fermate
        // precedenti ne' i loro orari. Calcolo l'indice della fermata focus e
        // taglio sia la sequenza fermate sia OGNI corsa da quell'indice in poi.
        // La sequenza COMPLETA (routeStops) resta disponibile per disegnare la
        // "barra percorso" (inizio -> capolinea) sopra la tabella.
        const allStops: any[] = Array.isArray(b.stops) ? b.stops : [];
        let fi = allStops.findIndex((s: any) => s && s.focus);
        if (fi < 0) fi = 0; // fallback: se non trovo il focus, mostro tutto
        const stopsFrom = allStops.slice(fi);
        const tripsFrom = (Array.isArray(b.trips) ? b.trips : [])
          .map((t: any[]) => (Array.isArray(t) ? t.slice(fi) : []))
          // scarto le corse che a partire dalla fermata cliccata non hanno
          // alcun orario valido (fermata non servita da quella corsa)
          .filter((t: any[]) => t.some((x) => x != null && x !== ''))
          // FIX-LUCA "board-render-cap": cap sulle corse per non generare troppe celle DOM
          .slice(0, this.MAX_TRIPS_PER_BOARD);
        groups[key].boards.push({
          dayLabel,
          routeStops: allStops,   // tutte le fermate (per la barra percorso)
          focusIdx: fi,           // posizione della fermata cliccata nel percorso
          stops: stopsFrom,       // fermate da quella cliccata al capolinea
          trips: tripsFrom,       // orari da quella cliccata al capolinea
        });
      }
    };

    // Feriale prima, poi Sabato, poi Domenica/festivi.
    addBoards(perDt['weekday'], 'Weekday (Mon-Fri)');
    addBoards(perDt['saturday'], 'Saturday');
    addBoards(perDt['sunday'], 'Sunday / holidays');

    // Ordino i gruppi per numero linea (numerico se possibile).
    order.sort((a, b) => {
      const la = groups[a].line, lb = groups[b].line;
      const na = parseInt(String(la).replace(/\D/g, ''), 10);
      const nb = parseInt(String(lb).replace(/\D/g, ''), 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(la).localeCompare(String(lb));
    });

    return order.map((k) => groups[k]);
  }

  /** trackBy per la lista dei gruppi-linea (perf su cambio settimana). */
  trackBoardGroup(_i: number, g: any): string { return g.key; }

  // FIX-LUCA "board-render-freeze": trackBy per i *ngFor INTERNI dei tabelloni.
  // SENZA questi, Angular ad ogni ciclo di change-detection DISTRUGGE e RICREA
  // tutte le righe/celle/colonne della tabella orari e della barra percorso.
  // Su fermate con molte corse (es. hub: 30 fermate x 30 corse = 900 celle per
  // board, x piu' board) questo satura il main thread e blocca la pagina
  // ("slowing down"). Con trackBy per indice Angular RIUSA gli elementi DOM
  // esistenti e il rendering resta leggero.
  trackByIndex(i: number, _item: any): number { return i; }
  trackBoardDay(i: number, bd: any): string { return (bd?.dayLabel || '') + '#' + i; }


  /**
   * PATCH-LUCA "board-index-counts" (2026-07-27):
   * Conteggio mostrato sotto "Linee & percorsi disponibili" nell'overlay orari:
   *   Lines:  numero di LINEE distinte che servono la fermata (valori g.line unici)
   *   Shapes: numero di PERCORSI/board distinti disponibili in questa settimana
   *           (ogni scheduleBoardGroups = una combinazione linea+capolinea = uno shape)
   * Riusa scheduleBoardGroups (gia' memoizzato), quindi il costo e' O(N) sul
   * numero di board, calcolato solo quando cambia fermata/settimana.
   */
  get scheduleLinesCount(): number {
    const set = new Set<string>();
    for (const g of this.scheduleBoardGroups) set.add(String(g.line));
    return set.size;
  }

  get scheduleShapesCount(): number {
    return this.scheduleBoardGroups.length;
  }

  // ============================================================
  // PATCH-LUCA "stop-frequency-stats" (2026-07-27) +
  // PATCH-LUCA "stop-freq-full-week-7days-RAW" (2026-07-27):
  // Le metriche di frequenza del popup orari (Total trip, Avg frequency daily,
  // Avg frequency hourly) NON sono piu' calcolate a runtime dai board (json
  // pre-aggregati per tipo-giorno). Ora sono lette da assets/stop_week_stats
  // .json, precalcolato OFFLINE dai DATI GREZZI GTFS (gen_stop_week_stats.py)
  // sui 7 giorni REALI di ciascuna settimana, senza distinzione feriale/festivo:
  //   total  = corse totali alla fermata su lun..dom della settimana selezionata
  //   daily  = total / 7    (SEMPRE diviso 7, anche se il bus circola 1 giorno)
  //   hourly = total / ore-di-servizio-settimanali
  // Chiave: weekStats[String(scheduleWeekIdx)][scheduleStop.id].
  // Memoizzato con la stessa chiave dei board (fermata#settimana).
  // ============================================================
  private _freqStatsCache: {
    weeklyTotal: number;
    avgDaily: number;
    avgHourly: number;
    hasAny: boolean;
  } | null = null;
  private _freqStatsCacheKey: string | null = null;

  /** Ricostruisce (o restituisce dalla cache) le statistiche di frequenza
   *  leggendole dai dati grezzi precalcolati (stop_week_stats.json). */
  private freqStats() {
    const sid = String(this.scheduleStop?.id ?? '');
    const wi = String(this.scheduleWeekIdx);
    const key = sid ? (sid + '#' + wi) : null;
    if (key === this._freqStatsCacheKey && this._freqStatsCache) {
      return this._freqStatsCache;
    }
    this._freqStatsCacheKey = key;

    const wk = this.weekStats[wi];
    const s = wk ? wk[sid] : undefined;
    if (s) {
      this._freqStatsCache = {
        weeklyTotal: s.total,
        avgDaily: s.daily,
        avgHourly: s.hourly,
        hasAny: s.total > 0,
      };
    } else {
      // dati non ancora caricati o fermata senza corse: valori a zero.
      this._freqStatsCache = { weeklyTotal: 0, avgDaily: 0, avgHourly: 0, hasAny: false };
    }
    return this._freqStatsCache;
  }

  // ============================================================
  // Getter esposti al template. Tutti riferiti all'INTERA settimana (7 giorni),
  // senza distinzione feriale/festivo, dai dati grezzi.
  //   total trip:               = corse totali sui 7 giorni della settimana
  //   Average frequency daily:  = corse settimana / 7
  //   Average frequency hourly: = corse settimana / ore-servizio-settimana
  // ============================================================

  /** Numero totale di corse che passano alla fermata nella settimana (7 giorni). */
  get stopFreqTotalTrips(): number {
    return this.freqStats().weeklyTotal;
  }

  /** Media corse/giorno sull'intera settimana (sempre diviso 7). */
  get stopFreqAvgDaily(): number {
    return this.freqStats().avgDaily;
  }

  /** Media corse/ora sull'intera settimana. */
  get stopFreqAvgHourly(): number {
    return this.freqStats().avgHourly;
  }

  /** True se c'e' almeno una corsa nella settimana (per mostrare la riga stats). */
  get stopFreqHasAny(): boolean {
    return this.freqStats().hasAny;
  }



  /**
   * FIX-LUCA "board-index-chips": scorre il corpo dell'overlay orari
   * (.sched-body) fino alla sezione (tabellone) della linea+capolinea con la
   * chiave passata. Chiamato al click su una card dell'indice in cima.
   * L'id dell'elemento sezione e' "board-<key>" (vedi *ngFor nel template).
   * Uso scrollIntoView dentro il contenitore scrollabile .sched-body.
   */
  scrollToBoardGroup(key: string): void {
    // Attendo un tick per essere sicuro che il DOM sia aggiornato, poi scrollo.
    window.setTimeout(() => {
      const safe = (window as any).CSS && (window as any).CSS.escape
        ? (window as any).CSS.escape('board-' + key)
        : ('board-' + key).replace(/"/g, '\\"');
      const el = document.getElementById('board-' + key)
        || document.querySelector(`#${safe}`) as HTMLElement | null;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 0);
  }

  /** Colore leggibile per il pallino della linea (bianco -> grigio per visibilita'). */
  scheduleLineColor(hex: string): string {
    const c = this.normalizeColor(hex || '#7a1fa2');
    if (c.toUpperCase() === '#FFFFFF') return '#9ca3af';
    return c;
  }

  // === UI ===
  // PATCH-LUCA "sidebar-english-accordion":
  // Il layer si accende/spegne cliccando la "pill" (non piu' checkbox).
  // La freccia a destra apre/chiude l'accordion legenda con animazione.
  onToggleLayer(l: LayerCfg): void {
    const on = this.activeLayers.has(l.id);

    // PATCH-LUCA "split-transit-lines":
    // I due layer 'heatmap_lines_freq' e 'heatmap_lines_livery' sono
    // mutuamente esclusivi: puntano allo stesso geojson ma con stile diverso.
    // Se ne accendo uno, l'altro deve spegnersi.
    const LINE_IDS = ['heatmap_lines_freq', 'heatmap_lines_livery'];
    if (!on && LINE_IDS.includes(l.id)) {
      for (const other of LINE_IDS) {
        if (other !== l.id && this.activeLayers.has(other)) {
          this.activeLayers.delete(other);
          this.removeLayer(other);
          // PATCH-LUCA "close-legend-on-mutex": spegnendo l'altro layer per
          // mutua esclusivita' (Transport lines <-> Heatmap frequency), chiudo
          // anche la SUA legenda, altrimenti resterebbe aperta pur essendo il
          // layer spento.
          this.openLegends.delete(other);
          // FIX-LUCA "mutex-reset-other-state" (richiesta Luca): spegnendo
          // l'ALTRO layer linee per mutua esclusivita', devo ripulire anche il
          // suo STATO LOGICO, esattamente come fa lo spegnimento manuale (ramo
          // 'if (on)'). Senza questo, il layer "Transport lines" (livery) NON
          // si chiudeva correttamente perche' restava con un filtro legenda
          // attivo (selectedLiveryColors/Lines) o il layer "Heatmap frequency"
          // restava con raster/celle in mappa e una shape selezionata.
          if (other === 'heatmap_lines_livery') {
            // Transport lines: azzero la selezione della legenda (colori +
            // singole linee) cosi' alla riaccensione riparte "pulito".
            // PATCH-LUCA "reset-livery-filter-on-toggle-2026-09-01": azzero
            // TUTTI i set di filtro (modi + linee + coppie modo/colore), non solo
            // i colori, coerentemente con lo spegnimento manuale.
            this.selectedLiveryColors.clear();
            this.selectedLiveryLines.clear();
            this.selectedLiveryModes.clear();
            this.selectedLiveryModeColors.clear();
            this.selectedLiveryLineKeys.clear();
          }
          if (other === 'heatmap_lines_freq') {
            // Heatmap frequency: reset selezione shape + rimozione del raster
            // PNG e delle celle cliccabili dalla mappa.
            this.freqSelectedShapeId = '';
            this.freqInfo = null;
            this.removeFreqRasterOverlay();
            this.removeFreqCellsLayer();
          }
        }
      }
      // Imposto la modalita' di rendering in base al pulsante scelto
      this.lineStyleMode = l.id === 'heatmap_lines_livery' ? 'livery' : 'qml';
    }

    if (on) {
      this.activeLayers.delete(l.id);
      this.removeLayer(l.id);
      // PATCH-LUCA "auto-open-legend": spegnendo il layer, se la sua legenda
      // era aperta la richiudo.
      this.openLegends.delete(l.id);
      // PATCH-LUCA "reset-theme-on-off": spegnendo Transport stop, resetto la
      // tematizzazione a 'uniform' (= None), cosi' alla prossima riaccensione
      // riparte dal default e nessun radio resta "selezionato" a layer spento.
      if (l.id === 'stops_clipped') {
        this.stopThemeMode = 'uniform';
        // FIX-LUCA "reach-buffers-off-with-layer-2026-11-09" (richiesta Luca):
        // spegnendo il layer Transport stop mentre la tematizzazione attiva e'
        // "walking reach (400m)", i cerchi da 400 m NON devono restare orfani
        // in mappa. Prima l'utente era costretto a mettere "None" e POI spegnere.
        // Avendo gia' riportato stopThemeMode a 'uniform', syncReachBuffers()
        // (che rimuove il group quando la modalita' non e' 'reach') cancella i
        // buffer. removeLayer() ha comunque una rimozione di sicurezza analoga.
        this.syncReachBuffers();
      }
      // PATCH-LUCA "livery-legend-select": spegnendo Transport lines resetto
      // la selezione della legenda (tutte le linee tornano "accese" al prossimo
      // riaccendersi del layer).
      // PATCH-LUCA "reset-livery-filter-on-toggle-2026-09-01" (richiesta Luca):
      // il filtro attivo NON vive piu' solo in selectedLiveryColors: ora lavora
      // su selectedLiveryModes + selectedLiveryLineKeys (+ il vecchio
      // selectedLiveryLines / selectedLiveryModeColors). Azzerando solo i colori,
      // spegnendo e riaccendendo il layer dal suo pulsante la selezione
      // precedente RESTAVA e ricompariva. Qui azzero TUTTI i set di filtro cosi'
      // la riaccensione mostra SEMPRE tutte le linee (reset completo). NB: questo
      // NON tocca il caso "chiudo solo la legenda senza spegnere il layer"
      // (openLegends), che infatti mantiene la selezione.
      if (l.id === 'heatmap_lines_livery') {
        this.selectedLiveryColors.clear();
        this.selectedLiveryLines.clear();
        this.selectedLiveryModes.clear();
        this.selectedLiveryModeColors.clear();
        this.selectedLiveryLineKeys.clear();
      }
      // PATCH-LUCA "freq-shape-select": spegnendo Heatmap frequency resetto
      // l'eventuale selezione shape (info-box chiuso, dimming annullato).
      if (l.id === 'heatmap_lines_freq') {
        this.freqSelectedShapeId = '';
        this.freqInfo = null;
        // PATCH-LUCA "freq-raster-overlay": spengo anche il raster PNG.
        this.removeFreqRasterOverlay();
        // PATCH-LUCA "freq-raster-cells-click": e le celle cliccabili.
        this.removeFreqCellsLayer();
      }
      // PATCH-LUCA "grid5m-second-freq-layer-2026-08-24": spegnendo il 2o layer
      // Heatmap frequency (quadratini 5x5) rimuovo le tessere dalla mappa.
      if (l.id === 'heatmap_lines_grid5m') {
        this.removeGrid5mCellsLayer();
      }
      // PATCH-LUCA "heatmap-raster-tif-layer": spegnendo il layer "Heatmap
      // raster" rimuovo il suo imageOverlay PNG dalla mappa.
      if (l.id === 'heatmap_raster') {
        this.removeRasterHeatmapOverlay();
      }
      // PATCH-LUCA "coverage-raster-tif-2026-08-27": spegnendo Population
      // coverage rimuovo il GeoTIFF dalla mappa e stacco il click del popup.
      if (l.kind === 'coverage_raster') {
        this.removeCoverageRaster();
      }
      // PATCH-LUCA "transit-desert-as-tif-2026-09-08": spegnendo Transit deserts
      // rimuovo il GeoTIFF dalla mappa e stacco il click del popup.
      if (l.kind === 'deserts_raster') {
        this.removeDesertsRaster();
      }

      // PATCH-LUCA "line-layers-can-both-be-off" (richiesta Luca 2026-08-05):
      // I due layer-linea (Transport lines / Heatmap frequency) NON sono piu'
      // in comportamento RADIO. Ora possono anche essere ENTRAMBI spenti:
      // spegnendone uno, l'altro NON viene piu' riacceso automaticamente.
      // Resta valido SOLO il vincolo di mutua esclusivita' in ACCENSIONE
      // (ramo else / blocco "split-transit-lines"): non possono MAI essere
      // accesi insieme, ma possono essere entrambi spenti.
      // -> Il vecchio blocco FIX-LUCA "line-layers-radio" (che riaccendeva
      //    l'altro layer) e' stato RIMOSSO.
    } else {
      this.activeLayers.add(l.id);
      // PATCH-LUCA "freq-raster-only" (richiesta Luca 2026-08-04): il layer
      // "Heatmap frequency" deve mostrare SOLO il RASTER PNG (+ celle invisibili
      // per il click/popup), MAI le strade vettoriali (heatmap_freq_strade
      // .geojson disegnate da loadLayer con styleForLine, weight 3, visibili).
      // Quindi per heatmap_lines_freq NON chiamo loadLayer (che disegnava il
      // vettoriale sovrapposto al raster): aggiungo unicamente il PNG e le celle
      // trasparenti cliccabili. Per tutti gli altri layer il comportamento e'
      // invariato (loadLayer disegna la loro geometria).
      if (l.id === 'heatmap_lines_freq') {
        // SOLO raster PNG (heatmap bianco->rosso scuro).
        this.addFreqRasterOverlay();
        // + celle invisibili (fill/stroke opacity 0) per il click/popup.
        this.addFreqCellsLayer();
      } else if (l.id === 'heatmap_lines_grid5m') {
        // PATCH-LUCA "grid5m-second-freq-layer-2026-08-24": 2o layer Heatmap
        // frequency = quadratini 5x5 m colorati e cliccabili, caricati
        // on-demand a tessere (niente PNG, niente vettoriale strade).
        this.addGrid5mCellsLayer();
      } else if (l.id === 'heatmap_raster') {
        // PATCH-LUCA "heatmap-raster-tif-layer": 3o layer "Heatmap raster" =
        // solo l'imageOverlay del PNG tematizzato (dal raster_heatmap.tif).
        // Indipendente: NON tocca gli altri layer.
        this.addRasterHeatmapOverlay();
      } else if (l.kind === 'coverage_raster') {
        // PATCH-LUCA "coverage-raster-tif-2026-08-27": Population coverage =
        // GeoTIFF 4 bande letto con georaster (colore su pct_covered, popup a
        // 4 info al click). Nessun download di GeoJSON pesante.
        this.addCoverageRaster();
      } else if (l.kind === 'deserts_raster') {
        // PATCH-LUCA "transit-desert-as-tif-2026-09-08": Transit deserts =
        // GeoTIFF 3 bande letto con georaster (colore su pop_uncovered, popup con
        // abitanti non serviti al click). Nessun download di GeoJSON pesante.
        this.addDesertsRaster();
      } else if (l.kind === 'xyztiles') {

        this.addXyzTileLayer(l);
      } else {
        this.loadLayer(l);
      }
      // PATCH-LUCA "auto-open-legend" + "multi-open-legends": accendendo il
      // layer, la sua legenda si apre AUTOMATICAMENTE. NON chiudo le altre:
      // piu' legende possono restare aperte insieme.
      // PATCH-LUCA "stops-autoopen-2026-09-09" (richiesta Luca): RIMOSSA la
      // precedente eccezione "stops-no-autoopen" che teneva chiusa la legenda
      // di Transport stop (stops_clipped) all'accensione. Ora ANCHE Transport
      // stop apre AUTOMATICAMENTE la sua barra legenda (Service type +
      // Thematize + Active service types) quando il layer viene acceso, come
      // tutti gli altri layer.
      this.openLegends.add(l.id);
    }
  }

  onToggleLegend(l: LayerCfg, ev: Event): void {
    // stopPropagation: cliccare la freccia NON deve toggle-are il layer
    ev.stopPropagation();
    // PATCH-LUCA "multi-open-legends": toggle indipendente nel Set, senza
    // chiudere le altre legende gia' aperte.
    if (this.openLegends.has(l.id)) {
      this.openLegends.delete(l.id);
    } else {
      this.openLegends.add(l.id);
    }
  }

  /** True se la legenda del layer id e' aperta. */
  isLegendOpen(id: string): boolean {
    return this.openLegends.has(id);
  }

  isLayerOn(id: string): boolean {
    return this.activeLayers.has(id);
  }

  // ============================================================
  // PATCH-LUCA "category-as-normal-pill":
  // La categoria "Transport stop accessability" (id 'transport') deve
  // comportarsi ESATTAMENTE come gli altri pulsanti-layer della sidebar:
  //   - stesso layer-pill (icona + label + freccia accordion);
  //   - la legenda "Walking time" NON e' piu' un blocco fisso dentro il
  //     riquadro viola .walking-legend, ma il contenuto dell'accordion che
  //     scende sotto il pulsante quando lo si apre (come le altre legende);
  //   - la freccia apre/chiude la legenda come per gli altri layer.
  // Per riusare lo stesso <ng-template #layerItem> costruisco un LayerCfg-like
  // "virtuale" (categoryPill) con id 'transport', label e icona della categoria.
  // I metodi pillIsOn / pillToggle instradano il click al comportamento giusto:
  //   - id 'transport' -> onSelectCategory (accende/spegne i poligoni 15-min);
  //   - altri id       -> onToggleLayer (comportamento layer standard).
  // La legenda accordion (open/close) usa lo STESSO openLegends/isLegendOpen/
  // onToggleLegend di tutti gli altri, quindi 'transport' e' una chiave in piu'
  // nel Set openLegends.
  // ============================================================

  /** LayerCfg "virtuale" per il pulsante-categoria, usato dal template #layerItem. */
  get categoryPill(): LayerCfg {
    const cat = this.categories.find((c) => c.id === 'transport');
    return {
      id: 'transport',
      label: cat ? cat.label : 'Transport stop accessibility',
      file: '',
      kind: 'polygons',
      iconHtml: cat ? cat.iconHtml : undefined,
    } as LayerCfg;
  }

  /** True se il pulsante (layer o categoria) e' "acceso". */
  pillIsOn(l: LayerCfg): boolean {
    if (l.id === 'transport') return this.activeCategory === 'transport';
    return this.isLayerOn(l.id);
  }

  /** Toggle del pulsante: instrada categoria vs layer. */
  pillToggle(l: LayerCfg): void {
    if (l.id === 'transport') {
      this.onSelectCategory('transport');
      // PATCH-LUCA "category-legend-auto-open": accendendo la categoria apro
      // automaticamente la sua legenda "Walking time" (come fanno gli altri
      // layer che aprono la loro legenda all'accensione); spegnendola la chiudo.
      if (this.activeCategory === 'transport') {
        this.openLegends.add('transport');
      } else {
        this.openLegends.delete('transport');
      }
    } else {
      this.onToggleLayer(l);
    }
  }

  // PATCH-LUCA "category-toggle" + "category-color-transition-v2":
  // Click sulla categoria = toggle. Se clicco una categoria diversa dall'attiva
  // -> divento attiva e mostro i poligoni con quel colore. Se ri-clicco la
  // categoria gia' attiva -> spengo tutto (nessuna attiva, poligoni nascosti).
  //
  // NOVITA' v2: quando cambio DA una categoria a un'altra (es. health -> entertainment)
  // NON aggiorno lo stile in modo istantaneo, ma lo interpolo frame per frame
  // con requestAnimationFrame (animateCategoryChange). Cosi' l'utente vede i
  // colori degli esagoni "fluire" dalla vecchia palette alla nuova in ~400ms.
  // Il tentativo di farlo via CSS transition su fill/stroke NON funzionava:
  // molti browser non animano le proprieta' SVG cambiate via setStyle.
  onSelectCategory(catId: string): void {
    const cfg = this.layers.find((x) => x.id === 'transport_15min');
    if (!cfg) return;

    if (this.activeCategory === catId) {
      // stessa categoria -> spengo (nessuna animazione: sparisce il layer)
      this.activeCategory = '';
      // PATCH-LUCA "transport-15min-pure-geojson-2026-09-02" (richiesta Luca):
      // il layer NON usa piu' le tessere on-demand (transport_tiles): mostro il
      // transport_15min.geojson PURO caricato in un colpo solo. Allo spegnimento
      // basta rimuovere il layer geojson dalla mappa (niente removePolyTilesLayer).
      this.removeLayer('transport_15min');
      return;
    }

    // PATCH-LUCA "transport-15min-pure-geojson-2026-09-02" (richiesta Luca):
    // Il layer "Transport stop accessability" mostra ORA il file INTERO
    // transport_15min.geojson (assets/transport_15min.geojson), caricato in un
    // colpo solo, SENZA il sistema di tessere on-demand (transport_tiles).
    // Uso il geojson gia' precaricato in ngAfterViewInit (polygonsGeojsonCache):
    // se e' pronto lo disegno subito con buildAndShowPolygons (fade-in animato);
    // altrimenti lo fetcho al volo dal file e poi lo disegno.
    this.activeCategory = catId;
    if (this.polygonsGeojsonCache) {
      this.buildAndShowPolygons(this.polygonsGeojsonCache, 400);
    } else {
      fetch(cfg.file)
        .then((r) => (r.ok ? r.json() : null))
        .then((gj) => {
          this.zone.run(() => {
            if (!gj) { console.error('[transport-15min] geojson non caricato'); return; }
            this.polygonsGeojsonCache = gj;
            this.dataCache['polygons'] = gj;
            // se nel frattempo la categoria e' stata spenta, non disegno.
            if (this.activeCategory === catId) this.buildAndShowPolygons(gj, 400);
          });
        })
        .catch((err) => { console.error('[transport-15min] errore fetch geojson', err); });
    }
  }

  /**
   * PATCH-LUCA "preload-polygons-no-lag":
   * Costruisce il layer poligoni dal GeoJSON gia' in cache e lo mostra con
   * un fade-in animato che parte immediatamente (nessun fetch nel mezzo).
   */
  private buildAndShowPolygons(gj: any, durationMs: number): void {
    const layer = L.geoJSON(gj, {
      pane: 'polygonsPane',
      // PATCH-LUCA "polygons-canvas-renderer-2026-08-06": renderer canvas per
      // reggere le 178k celle senza appesantire il DOM (vedi polygonsRenderer).
      renderer: this.polygonsRenderer,
      style: (f: any) => this.styleForPolygon(f),
      onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, 'transport_15min'),
    } as any);
    layer.addTo(this.map);
    this.layerCache.set('transport_15min', layer);
    this.animatePolygonsFadeIn(layer, durationMs);
  }

  // ============================================================
  // PATCH-LUCA "transport-cells-ondemand-tiles-2026-08-06":
  // Sistema di caricamento ON-DEMAND per viewport degli esagoni Transport.
  // Gemello di addFreqCellsLayer/refreshFreqTilesInView/removeFreqCellsLayer.
  // ============================================================

  /**
   * Accende il sistema di esagoni ON-DEMAND. Invece di caricare l'unico file
   * da ~43MB (178k esagoni), carica l'index delle tessere (una volta), crea un
   * LayerGroup nel polygonsPane e aggancia un handler moveend/zoomend che carica
   * SOLO le tessere nel viewport corrente. Ogni esagono mantiene stile
   * (styleForPolygon) e popup identici all'originale.
   */
  private addPolyTilesLayer(): void {
    this.polyTilesActive = true;

    // Crea (una sola volta) il LayerGroup contenitore delle tessere.
    if (!this.polyTilesGroup) {
      this.polyTilesGroup = L.layerGroup();
    }
    if (!this.map.hasLayer(this.polyTilesGroup)) {
      this.polyTilesGroup.addTo(this.map);
    }

    // Aggancia (una sola volta) l'handler che ricarica le tessere visibili
    // ad ogni fine spostamento/zoom della mappa.
    if (!this._polyMoveHandler) {
      this._polyMoveHandler = () => {
        this.zone.runOutsideAngular(() => this.refreshPolyTilesInView());
      };
      this.map.on('moveend', this._polyMoveHandler);
      this.map.on('zoomend', this._polyMoveHandler);
    }

    // Carica l'index delle tessere (una sola volta), poi popola la vista.
    if (this.polyTilesIndex) {
      this.refreshPolyTilesInView();
      return;
    }
    fetch(this.POLY_TILES_INDEX_JSON)
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => {
        this.zone.run(() => {
          if (!idx || !idx.tiles) {
            console.error('[transport-cells] index tessere non valido');
            return;
          }
          this.polyTilesIndex = idx;
          // Se nel frattempo la categoria e' stata spenta, non faccio nulla.
          if (!this.polyTilesActive) return;
          this.refreshPolyTilesInView();
        });
      })
      .catch((err) => { console.error('[transport-cells] index tessere non caricato', err); });
  }

  /**
   * Carica le tessere degli esagoni che intersecano il viewport corrente e
   * scarica quelle uscite dalla vista, mantenendo il canvas leggero. Sotto
   * POLY_TILES_MIN_ZOOM (vista troppo ampia) non carico nulla ed esco.
   */
  private refreshPolyTilesInView(): void {
    if (!this.polyTilesActive || !this.polyTilesIndex || !this.polyTilesGroup) return;
    const deg = this.polyTilesIndex.tile_deg;
    const wanted = new Set<string>();

    // A zoom basso NON carico esagoni (vista troppo ampia = tutto il comune).
    if (this.map.getZoom() >= this.POLY_TILES_MIN_ZOOM) {
      const b = this.map.getBounds().pad(0.15); // piccolo margine oltre il bordo
      const ix0 = Math.floor(b.getWest() / deg);
      const ix1 = Math.floor(b.getEast() / deg);
      const iy0 = Math.floor(b.getSouth() / deg);
      const iy1 = Math.floor(b.getNorth() / deg);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const key = ix + '_' + iy;
          if (this.polyTilesIndex.tiles[key]) wanted.add(key);
        }
      }
    }

    // Rimuovo le tessere non piu' desiderate (uscite dalla vista o zoom-out).
    for (const [key, lyr] of this.polyTilesLoaded) {
      if (!wanted.has(key)) {
        this.polyTilesGroup.removeLayer(lyr);
        this.polyTilesLoaded.delete(key);
      }
    }

    // Carico le tessere mancanti (fetch del solo file di quella tessera).
    for (const key of wanted) {
      if (this.polyTilesLoaded.has(key)) continue;
      // Segnaposto immediato per evitare doppi fetch della stessa tessera.
      const placeholder = L.geoJSON(undefined as any);
      this.polyTilesLoaded.set(key, placeholder);
      const fname = this.polyTilesIndex.tiles[key];
      fetch(this.POLY_TILES_DIR + fname)
        .then((r) => (r.ok ? r.json() : null))
        .then((gj) => {
          // Se nel frattempo la categoria e' stata spenta o la tessera e' uscita
          // dalla vista, non aggiungo nulla.
          if (!gj || !this.polyTilesActive || !this.polyTilesGroup) return;
          if (this.polyTilesLoaded.get(key) !== placeholder) return; // gia' sostituita
          const tileLayer = L.geoJSON(gj, {
            pane: 'polygonsPane',
            renderer: this.polygonsRenderer,
            // Stile e popup IDENTICI al layer monolitico originale.
            style: (f: any) => this.styleForPolygon(f),
            onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, 'transport_15min'),
          } as any);
          this.polyTilesLoaded.set(key, tileLayer);
          this.polyTilesGroup.addLayer(tileLayer);
        })
        .catch((err) => {
          console.error('[transport-cells] tessera non caricata', fname, err);
          // libero il segnaposto cosi' un futuro refresh possa ritentare
          if (this.polyTilesLoaded.get(key) === placeholder) this.polyTilesLoaded.delete(key);
        });
    }
  }

  /** Rimuove TUTTE le tessere esagoni dalla mappa e stacca gli handler di vista. */
  private removePolyTilesLayer(): void {
    this.polyTilesActive = false;
    if (this._polyMoveHandler) {
      this.map.off('moveend', this._polyMoveHandler);
      this.map.off('zoomend', this._polyMoveHandler);
      this._polyMoveHandler = null;
    }
    if (this.polyTilesGroup) {
      this.polyTilesGroup.clearLayers();
      if (this.map.hasLayer(this.polyTilesGroup)) this.map.removeLayer(this.polyTilesGroup);
    }
    this.polyTilesLoaded.clear();
  }

  /**
   * PATCH-LUCA "smooth-appear":
   * Fa comparire i poligoni con un fade-in fluido (fillOpacity/opacity da 0 al
   * valore canonico) partendo SUBITO. Evita che gli esagoni "sbattano" in
   * mappa di colpo. Ogni feature parte gia' col colore giusto (styleForPolygon),
   * si anima solo l'opacita' -> nessun frame di vuoto ne' scatto.
   */
  private animatePolygonsFadeIn(layer: L.GeoJSON, durationMs: number): void {
    // PATCH-LUCA "polygons-canvas-renderer-2026-08-06": su dataset MOLTO grandi
    // (Madrid: 178k celle su canvas) l'animazione frame-by-frame che chiama
    // setStyle su ogni cella ad ogni rAF farebbe ridisegnare l'intero canvas
    // decine di volte -> scatti. Sopra una soglia salto l'animazione e applico
    // subito lo stile pieno (comparsa istantanea, mappa fluida). Sotto soglia
    // (es. Leuven) resta il fade-in morbido di prima.
    let nFeat = 0;
    layer.eachLayer(() => { nFeat++; });
    if (nFeat > 20000) {
      layer.setStyle((f) => this.styleForPolygon(f));
      return;
    }
    // Stile canonico applicato subito, ma con opacita' 0.
    layer.eachLayer((sub: any) => {
      if (typeof sub.setStyle === 'function') {
        sub.setStyle({ fillOpacity: 0, opacity: 0 });
      }
    });

    const start = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);
      const t = easeOutCubic(raw);
      layer.eachLayer((sub: any) => {
        const f = sub.feature;
        const target = this.styleForPolygon(f);
        const tFill = (target.fillOpacity ?? this.transportOpacity) as number;
        const tStroke = (target.opacity ?? this.transportOpacity) as number;
        if (typeof sub.setStyle === 'function') {
          sub.setStyle({ fillOpacity: tFill * t, opacity: tStroke * t });
        }
      });
      if (raw < 1) {
        requestAnimationFrame(step);
      } else {
        // snap finale allo stile canonico pieno
        layer.setStyle((f) => this.styleForPolygon(f));
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * PATCH-LUCA "category-color-transition-v5 (minutes morph, palette-locked)":
   * Anima il passaggio dei colori degli esagoni da fromCat -> toCat.
   *
   * STORIA:
   *  - v2 (RGB lerp): passava per marrone/oliva (muddy midpoint).
   *  - v3 (cross-fade fillOpacity): a t=0.5 opacita' 0 -> "momento di vuoto".
   *  - v4 (HSL morph): niente vuoto ne' marrone, ma interpolando l'hue sul
   *    cerchio da rosso a verde passa per GIALLO PIENO (hue 60), che pero'
   *    NON e' un colore che appartiene ad alcun esagono in quel punto.
   *    L'utente vedeva "un momento in cui tutto diventa giallo" - un colore
   *    inventato che non fa parte della palette.
   *
   * v5 - MORPH SUI MINUTI (non sui colori):
   *   L'idea: invece di interpolare RGB o HSL fra due colori, interpoliamo
   *   il VALORE IN MINUTI di ogni esagono da fromMinutes -> toMinutes, e ad
   *   ogni frame calcoliamo il colore con la STESSA funzione colorForMinutes
   *   usata dalla legenda "Walking time (min)".
   *
   *   Cosi' l'esagono attraversa esclusivamente colori che compaiono nella
   *   legenda:
   *     verde (0-15) -> giallo (15-30) -> arancio (30-40) -> rosso (40-60)
   *     -> bordeaux (60) -> grigio (>60)
   *   Se un esagono passa da 45 (rosso) a 5 (verde), scorrera' rosso ->
   *   arancio -> giallo -> verde, ma SEMPRE lungo la scala reale.
   *   Se un esagono passa da 25 (giallo) a 45 (rosso), NON tocchera' mai
   *   il verde: scorrera' giallo -> arancio -> rosso.
   *   Se un esagono ha lo stesso valore in minuti nelle 2 categorie, non
   *   si muove per niente (skip).
   *
   *   Casi particolari:
   *     - null (feature senza valore per la categoria) -> stile grigio
   *       trasparente. In transizione da/verso null usiamo cross-fade
   *       dell'alpha del grigio, restando comunque su colori della palette
   *       (grigio chiaro).
   *     - >60 -> grigio pieno (#9ca3af): stesso trattamento.
   *
   *   fillOpacity e opacity restano COSTANTI: mai frame di vuoto.
   *   Durata 500ms con easeInOutCubic.
   */
  private animateCategoryChange(
    layer: L.GeoJSON,
    fromCat: string,
    toCat: string,
    durationMs: number
  ): void {
    // Per ogni feature classifichiamo in una delle categorie sotto e
    // pre-calcoliamo i valori numerici. Questo evita di rifare parseMinutes
    // ad ogni frame.
    type Kind = 'val'    // entrambi hanno un valore numerico 0..60 -> interpolo minuti
              | 'toGrey' // val -> >60 (grigio pieno)
              | 'fromGrey'
              | 'toNull' // val -> null
              | 'fromNull'
              | 'nullNull' // entrambi null (skip)
              | 'greyGrey' // entrambi >60 (skip)
              | 'same';    // stessi minuti (skip)
    interface Item {
      path: L.Path;
      kind: Kind;
      fromM: number;  // usati solo quando servono
      toM: number;
      fillOp: number;
      strokeOp: number;
    }
    const items: Item[] = [];

    layer.eachLayer((sub) => {
      const path = sub as L.Path;
      const feature = (sub as any).feature;
      const fromRaw = this.getMinutesForCategory(feature, fromCat);
      const toRaw   = this.getMinutesForCategory(feature, toCat);
      // fromRaw / toRaw sono number | null.  number > 60 -> grigio pieno.

      const fromNull = fromRaw == null;
      const toNull   = toRaw   == null;
      const fromGrey = !fromNull && (fromRaw as number) > 60;
      const toGrey   = !toNull   && (toRaw   as number) > 60;

      let kind: Kind;
      if (fromNull && toNull) kind = 'nullNull';
      else if (fromNull)      kind = 'fromNull';
      else if (toNull)        kind = 'toNull';
      else if (fromGrey && toGrey) kind = 'greyGrey';
      else if (fromGrey)      kind = 'fromGrey';
      else if (toGrey)        kind = 'toGrey';
      else if (Math.abs((fromRaw as number) - (toRaw as number)) < 0.01) kind = 'same';
      else kind = 'val';

      items.push({
        path,
        kind,
        fromM: fromNull ? 0 : (fromRaw as number),
        toM:   toNull   ? 0 : (toRaw   as number),
        fillOp: 0.60,      // valore target per esagoni con valore
        strokeOp: 0.48,
      });
    });

    const start = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // Costanti per il grigio "val > 60" e per il grigio "null".
    const GREY_FULL = '#9ca3af';
    const GREY_NULL = '#cccccc';
    const NULL_FILL_OP = 0.20;
    const NULL_STROKE_OP = 0.32;

    const step = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);
      const t = easeInOutCubic(raw);

      for (const it of items) {
        if (it.kind === 'same' || it.kind === 'nullNull' || it.kind === 'greyGrey') {
          continue; // esagono invariato: non toccarlo mai
        }

        let color: string;
        let fillOp: number;
        let strokeOp: number;

        if (it.kind === 'val') {
          // Interpolo i minuti (clampati a 0..60) e coloro con colorForMinutes.
          // Cosi' l'esagono scorre solo attraverso i colori della legenda,
          // nell'ordine giusto in base al percorso richiesto sulla scala.
          const m = it.fromM + (it.toM - it.fromM) * t;
          color = this.colorForMinutes(Math.max(0, Math.min(60, m)));
          fillOp = it.fillOp;
          strokeOp = it.strokeOp;
        } else if (it.kind === 'toGrey') {
          // val -> grigio pieno: interpolo minuti verso 60 fino a t=0.7,
          // poi cross-fade finale verso GREY_FULL. In pratica lasciamo che
          // scenda dentro la scala fino a bordeaux e poi diventi grigio.
          if (t < 0.7) {
            const localT = t / 0.7;
            const m = it.fromM + (60 - it.fromM) * localT;
            color = this.colorForMinutes(Math.max(0, Math.min(60, m)));
          } else {
            // ultimo tratto: da bordeaux -> grigio pieno lungo la sua tinta
            const localT = (t - 0.7) / 0.3;
            color = this.lerpHexInHsl('#7f1d1d', GREY_FULL, localT);
          }
          fillOp = it.fillOp;
          strokeOp = it.strokeOp;
        } else if (it.kind === 'fromGrey') {
          // grigio pieno -> val: simmetrico
          if (t < 0.3) {
            const localT = t / 0.3;
            color = this.lerpHexInHsl(GREY_FULL, '#7f1d1d', localT);
          } else {
            const localT = (t - 0.3) / 0.7;
            const m = 60 + (it.toM - 60) * localT;
            color = this.colorForMinutes(Math.max(0, Math.min(60, m)));
          }
          fillOp = it.fillOp;
          strokeOp = it.strokeOp;
        } else if (it.kind === 'toNull') {
          // val (o grigio) -> null: fade dello stile "colorato" verso il
          // grigio-chiaro trasparente dei null. Colore verso GREY_NULL,
          // opacita' verso i valori del null.
          color = this.lerpHexInHsl(
            fromGreyStart(it),
            GREY_NULL,
            t
          );
          fillOp = it.fillOp + (NULL_FILL_OP - it.fillOp) * t;
          strokeOp = it.strokeOp + (NULL_STROKE_OP - it.strokeOp) * t;
        } else {
          // fromNull: null -> val (o grigio)
          color = this.lerpHexInHsl(
            GREY_NULL,
            toGreyEnd(it),
            t
          );
          fillOp = NULL_FILL_OP + (it.fillOp - NULL_FILL_OP) * t;
          strokeOp = NULL_STROKE_OP + (it.strokeOp - NULL_STROKE_OP) * t;
        }

        it.path.setStyle({
          color: color,
          fillColor: color,
          fillOpacity: fillOp,
          opacity: strokeOp,
        });
      }

      if (raw < 1) {
        requestAnimationFrame(step);
      } else {
        // Snap finale con lo stile "canonico"
        layer.setStyle((f) => this.styleForPolygon(f));
      }
    };

    // Helper interni per ricavare il colore di partenza/arrivo negli edge
    // cases toNull/fromNull (dove fromM/toM potrebbe essere fuori scala).
    // Definiti come closures per accedere alle costanti sopra.
    function fromGreyStart(it: Item): string {
      // qui kind === 'toNull', quindi il from ha un valore reale
      // (val 0..60 oppure > 60 grigio pieno)
      if (it.fromM > 60) return GREY_FULL;
      const m = Math.max(0, Math.min(60, it.fromM));
      return this_colorForMinutes(m);
    }
    function toGreyEnd(it: Item): string {
      // kind === 'fromNull', quindi il to ha un valore reale
      if (it.toM > 60) return GREY_FULL;
      const m = Math.max(0, Math.min(60, it.toM));
      return this_colorForMinutes(m);
    }
    // Non posso usare "this" dentro function declarations classiche senza
    // bind: creo una scorciatoia locale.
    const this_colorForMinutes = (m: number) => this.colorForMinutes(m);

    requestAnimationFrame(step);
  }

  /**
   * Ritorna il valore in minuti di una feature per una data categoria,
   * usando la stessa logica di styleForPolygon/styleForCategory.
   * Restituisce null se il campo manca. Valori > 60 sono restituiti tali
   * quali cosi' il chiamante puo' distinguere "grigio pieno" da "colorato".
   */
  private getMinutesForCategory(f: any, catId: string): number | null {
    const cat = this.categories.find((c) => c.id === catId);
    const prop = cat?.prop ?? 'overall_average';
    const rawVal = f?.properties ? f.properties[prop] : null;
    return this.parseMinutes(rawVal);
  }

  /**
   * Interpolazione di due colori hex in spazio HSL con shortest-path
   * dell'hue. Usato SOLO per i tratti transitori tra grigio e palette
   * (edge cases null <-> val, val <-> >60). Per l'interpolazione principale
   * dentro la palette usiamo invece colorForMinutes.
   */
  private lerpHexInHsl(a: string, b: string, t: number): string {
    const [h1, s1, l1] = this.hexToHsl(a);
    const [h2, s2, l2] = this.hexToHsl(b);
    // Se una delle due tinte e' desaturata (grigio), non ha senso ruotare
    // sul cerchio: uso l'hue dell'altra per non attraversare colori spuri.
    let h1e = h1, h2e = h2;
    if (s1 < 0.02) h1e = h2;
    if (s2 < 0.02) h2e = h1;
    const h = this.lerpHueShort(h1e, h2e, t);
    const s = s1 + (s2 - s1) * t;
    const l = l1 + (l2 - l1) * t;
    return this.hslToHex(h, s, l);
  }

  /** Confronto tra due colori (hex o rgb(...)) per capire se sono uguali. */
  private colorsEqual(a: string, b: string): boolean {
    return this.canonicalHex(a) === this.canonicalHex(b);
  }

  /** Riduce hex/rgb() a #rrggbb lowercase. */
  private canonicalHex(c: string): string {
    if (!c) return '#000000';
    const s = String(c).trim().toLowerCase();
    if (s.startsWith('#') && s.length === 7) return s;
    if (s.startsWith('#') && s.length === 4) {
      // #rgb -> #rrggbb
      return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    const m = s.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const toHex = (v: string) => parseInt(v, 10).toString(16).padStart(2, '0');
      return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
    }
    return s;
  }

  /** hex #rrggbb -> [h(0..1), s(0..1), l(0..1)] */
  private hexToHsl(hex: string): [number, number, number] {
    const h = this.canonicalHex(hex).replace('#', '');
    if (h.length !== 6) return [0, 0, 0.5];
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let hh = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: hh = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: hh = ((b - r) / d + 2); break;
        case b: hh = ((r - g) / d + 4); break;
      }
      hh /= 6;
    }
    return [hh, s, l];
  }

  /** [h,s,l] (0..1) -> hex #rrggbb */
  private hslToHex(h: number, s: number, l: number): string {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r: number, g: number, b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  /**
   * Interpolazione hue sulla via piu' corta sul cerchio [0..1).
   * Es: da 0.95 a 0.05 va avanti (attraverso lo zero) invece di tornare indietro
   * facendo 0.95 -> 0.5 -> 0.05.
   */
  private lerpHueShort(a: number, b: number, t: number): number {
    let d = b - a;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    let r = a + d * t;
    if (r < 0) r += 1;
    if (r > 1) r -= 1;
    return r;
  }

  /**
   * Variante "pura" di styleForPolygon che accetta la categoria come parametro
   * invece di leggerla da this.activeCategory. Serve per calcolare in anticipo
   * gli stili "from" e "to" durante l'animazione di cambio categoria.
   */
  private styleForCategory(f: any, catId: string): L.PathOptions {
    const cat = this.categories.find((c) => c.id === catId);
    const prop = cat?.prop ?? 'overall_average';
    const rawVal = f?.properties ? f.properties[prop] : null;
    const val = this.parseMinutes(rawVal);

    if (val == null) {
      return {
        color: '#cccccc',
        weight: 1,
        fillColor: '#cccccc',
        fillOpacity: 0.20,
        opacity: 0.32,
        lineJoin: 'round',
      };
    }
    const fill = val > 60 ? '#9ca3af' : this.colorForMinutes(val);
    return {
      color: fill,
      weight: 1,
      fillColor: fill,
      fillOpacity: 0.60,
      opacity: 0.48,
      lineJoin: 'round',
    };
  }


  isCategoryOn(catId: string): boolean {
    return this.activeCategory === catId;
  }

  // === Load / Remove ===
  private loadLayer(l: LayerCfg): void {
    // PATCH-LUCA "stops-multimode": il layer fermate non e' piu' un singolo
    // file, ma l'unione di stop_bus/stop_metro/stop_tram. Deviamo a un metodo
    // dedicato che fa i 3 fetch in parallelo, filtra e fonde.
    if (l.id === 'stops_clipped') {
      this.loadStopsMultimode(l);
      return;
    }
    fetch(l.file)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((gj) => {
        let layer: L.GeoJSON;
        if (l.kind === 'polygons') {
          // PATCH-LUCA "z-order-panes": esagoni nella pane piu' bassa.
          // PATCH-LUCA "polygons-canvas-renderer-2026-08-06": renderer canvas
          // (regge le 178k celle senza 178k <path> SVG -> mappa fluida).
          layer = L.geoJSON(gj, {
            pane: 'polygonsPane',
            renderer: this.polygonsRenderer,
            style: (f: any) => this.styleForPolygon(f),
            onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, l.id),
          } as any);
        } else if (l.kind === 'points') {
          // PATCH-LUCA "stops-5-tiers":
          // 5 categorie basate su lines_count (quante linee di bus servono
          // la fermata). Soglie da quantili puri sui dati reali (373 stops):
          //   Occasional (1 linea)      25%  raggio 3
          //   Local      (2)            17%  raggio 5
          //   Standard   (3-4)          28%  raggio 7
          //   Busy       (5-7)          20%  raggio 9
          //   Major hub  (8+)           10%  raggio 13
          // Colore fill = viola Deda (uniforme, l'informazione e' la size).
          // Le fermate con lines_count 0 (2 casi anomali) le tratto come
          // "Occasional" per non nasconderle.
          // PATCH-LUCA "stops-stroke-darker":
          // Il contorno del cerchio NON e' piu' bianco: usa lo stesso hue
          // del fill ma con luminosita' -15% (darkenHex), cosi ogni tier
          // ha un contorno coerente con la propria fascia viola.
          // PATCH-LUCA "z-order-panes": fermate nella pane piu' alta (stopsPane)
          // per stare sopra sia esagoni che linee di bus.
          layer = L.geoJSON(gj, {
            pointToLayer: (f, latlng) => {
              // PATCH-LUCA "stops-thematize": lo stile del pallino dipende
              // dalla modalita' di tematizzazione attiva (stopThemeMode).
              // Default 'uniform' = tutte viola, stessa dimensione grande.
              const v = this.stopVisual(f);
              // PATCH-LUCA "uniform-lighter-smaller-outline": in modalita'
              // uniform il contorno e' STOP_UNIFORM.stroke (viola attuale),
              // fill = viola piu' chiaro. Nelle altre modalita' contorno scurito.
              const stroke = this.stopThemeMode === 'uniform'
                ? this.STOP_UNIFORM.stroke
                : this.darkenHex(v.color, 0.15);
              return L.circleMarker(latlng, {
                pane: 'stopsPane',
                radius: v.radius,
                fillColor: v.color,
                color: stroke,
                weight: 1.2,
                fillOpacity: 0.90,
                opacity: 1,
              });
            },
            onEachFeature: (f: any, lyr: any) => {
              // PATCH-LUCA "stop-schedule-panel": al click su una fermata apro
              // il pannello laterale con la tabella oraria settimanale (invece
              // del popup grezzo con le properties). Rientro in NgZone perche'
              // l'evento Leaflet gira fuori dal change-detection Angular.
              lyr.on('click', () => {
                this.zone.run(() => this.openStopSchedule(f));
              });
            },
          });

        } else if (l.kind === 'coverage') {
          // PATCH-LUCA "new-layers-coverage-deserts":
          // Population coverage: poligoni tematizzati su pct_covered con la
          // palette Purples (styleForCoverage). Stessa pane dei poligoni
          // 15-minute (polygonsPane), sotto linee e fermate.
          layer = L.geoJSON(gj, {
            pane: 'polygonsPane',
            style: (f: any) => this.styleForCoverage(f),
            onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, l.id),
          });
        } else if (l.kind === 'deserts') {
          // PATCH-LUCA "new-layers-coverage-deserts":
          // Transit deserts: poligoni a colore unico rosso semitrasparente.
          // Uso linesPane cosi' stanno sopra gli esagoni/coverage ma sotto le
          // fermate, restando ben visibili come "aree di allerta".
          layer = L.geoJSON(gj, {
            pane: 'linesPane',
            style: (f: any) => this.styleForDeserts(f),
            onEachFeature: (f: any, lyr: any) => this.bindPopup(f, lyr, l.id),
          });
        } else if (l.kind === 'population') {
          // PATCH-LUCA "population-2025-layer":
          // Population 2025: tasselli 100x100 m con 'pop' = abitanti. Stessa
          // pane dei poligoni (polygonsPane), sotto linee e fermate. Ogni cella
          // e' CLICCABILE e mostra il numero di abitanti in un popup dedicato.
          layer = L.geoJSON(gj, {
            pane: 'polygonsPane',
            style: (f: any) => this.styleForPopulation(f),
            onEachFeature: (f: any, lyr: any) => {
              const pop = f?.properties?.['pop'];
              const n = typeof pop === 'number' ? pop : parseInt(pop, 10);
              const val = isNaN(n) ? 0 : n;
              const txt = val.toLocaleString('en-US');
              lyr.bindPopup(
                `<div style="font:13px/1.4 system-ui,sans-serif">
                   <div style="font-weight:600;margin-bottom:2px">Population 2025</div>
                   <div><b>${txt}</b> inhabitants</div>
                 </div>`
              );
            },
          });
        } else {
          // Il rendering delle linee ora ha 2 modalita' governate da
          // this.lineStyleMode ('qml' default, o 'livery'). Delego a
          // styleForLine() che ritorna le PathOptions giuste.
          // PATCH-LUCA "z-order-panes": linee nella pane intermedia (linesPane)
          // per stare sopra gli esagoni ma sotto le fermate.
          // PATCH-LUCA "freq-shape-select": per il layer "Heatmap frequency"
          // (heatmap_lines_freq) il click su una shape NON apre il popup ma
          // SELEZIONA la shape (sgrigia le altre + apre l'info-box). Per il
          // layer livery (heatmap_lines_livery) resta il popup informativo.
          layer = L.geoJSON(gj, {
            pane: 'linesPane',
            style: (f: any) => this.styleForLine(f),
            onEachFeature: (f: any, lyr: any) => {
              if (l.id === 'heatmap_lines_freq') {
                lyr.on('click', (ev: any) => {
                  this.zone.run(() => this.onSelectFreqShape(f, ev));
                });
              }
              // PATCH-LUCA "livery-click-all-lines": per il layer livery NON
              // bindo piu' un popup per-feature. Il click e' gestito a livello
              // di layer (onLiveryMapClick) per elencare TUTTE le linee sotto
              // al punto cliccato. Vedi sotto: layer.on('click', ...).
            },
          });
        }

        layer.addTo(this.map);
        this.layerCache.set(l.id, layer);

        // PATCH-LUCA "livery-legend-select": se il layer appena caricato e' il
        // Transport lines (livery) e c'e' un filtro attivo, lo riapplico
        // subito cosi' in mappa compaiono solo le linee selezionate.
        // PATCH-LUCA "livery-filter-on-load-allsets-2026-09-01" (richiesta Luca):
        // prima si controllava SOLO selectedLiveryColors, ma cliccando "Bus"
        // (o un modo/linea) a layer spento si popolano selectedLiveryModes /
        // selectedLiveryLineKeys, NON selectedLiveryColors: cosi' il filtro non
        // partiva e in mappa comparivano TUTTE le linee. Ora considero tutti i set.
        if (
          l.id === 'heatmap_lines_livery' &&
          (this.selectedLiveryColors.size > 0 ||
            this.selectedLiveryModes.size > 0 ||
            this.selectedLiveryLineKeys.size > 0)
        ) {
          this.applyLiveryFilter();
        }

        // PATCH-LUCA "livery-click-all-lines": aggancio il click sull'INTERO
        // layer livery (non per-feature): al click elenca TUTTE le linee che
        // passano nel punto cliccato (entro tolleranza) in un popup unico,
        // con nome + colore livrea, in ordine alfabetico.
        if (l.id === 'heatmap_lines_livery') {
          layer.on('click', (ev: any) => {
            this.zone.run(() => this.onLiveryMapClick(ev));
          });
        }

        // PATCH-LUCA "freq-zorder-by-frequency": appena caricato il layer
        // "Heatmap frequency", ordino le shape per frequency cosi' le piu'
        // trafficate stanno SOPRA e le meno trafficate SOTTO.
        if (l.id === 'heatmap_lines_freq') {
          this.applyFreqZOrder();
        }

        // PATCH-LUCA "keep-view-on-toggle" + "no-initial-zoom-out":
        // La view iniziale e' gia' impostata in ngAfterViewInit con
        //   .setView([50.8798, 4.7005], 13)  (centro Leuven, zoom 13)
        // quindi NON serve alcun fitBounds automatico al primo layer caricato.
        // Prima: al primissimo click su una categoria/layer, fitBounds spingeva
        // lo zoom sull'intero bounding box dei dati (spesso zoom out fastidioso)
        // e succedeva UNA SOLA volta, quindi l'utente vedeva un salto strano
        // solo alla prima interazione dopo l'apertura della pagina.
        // Ora la view resta SEMPRE quella scelta in ngAfterViewInit / dall'utente.
      })
      .catch((err) => {
        console.error(`Errore caricamento ${l.label}:`, err);
      });
  }
  // ============================================================
  // PATCH-LUCA "stops-multimode" (2026-09-01): caricamento fermate multi-modo.
  // Fa 3 fetch in parallelo (bus/metro/tram), scarta i file mancanti senza
  // errori, filtra le fermate "vere", tagga properties.mode, calcola le
  // condivise (stesse coordinate su piu' modi) e costruisce un unico layer.
  // ============================================================
  private loadStopsMultimode(l: LayerCfg): void {
    // PATCH-LUCA "stops-single-file-2026-01-09" (richiesta Luca): il layer
    // "Transport stop" NON carica piu' i 3 file per-modo (stop_bus/metro/tram
    // .geojson), ma UN SOLO file assets/stop.geojson (l.file), prodotto dallo
    // step 11 della pipeline (11_gen_stop_unico.py) dai 3 GTFS separati.
    // Ogni feature porta gia' dentro properties.mode ('bus'|'metro'|'tram') e,
    // per le fermate condivise fra modi, properties.sharedModes. Cosi' c'e' UNA
    // SOLA fonte di verita' per le fermate: al click il popup legge
    // stopInfo[stop_id] dallo STESSO stop_id presente qui -> mai piu' "No data
    // available". Il vecchio meccanismo a 3 fetch e' stato sostituito da questo
    // unico fetch; il resto della funzione (filtro location_type, calcolo dei
    // modi presenti, marker, filtro-modo, tematizzazione) resta invariato.
    Promise.resolve(
      fetch(l.file).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
    ).then((gj: any) => {
      const merged: any[] = [];
      const modesPresent = new Set<'bus' | 'metro' | 'tram'>();

      const feats = Array.isArray(gj?.features) ? gj.features : [];
      for (const f of feats) {
        // Tengo solo le fermate "vere": location_type vuoto o '0'.
        // Scarto stazioni-contenitore ('1'), accessi/uscite ('2'),
        // nodi generici ('3') e aree di imbarco ('4'). NB: lo step 11 gia'
        // scarta gli accessi, ma tengo il filtro per robustezza.
        const lt = String(f?.properties?.['location_type'] ?? '').trim();
        if (lt !== '' && lt !== '0') continue;
        if (!f.properties) f.properties = {};
        // Il modo arriva GIA' dal file unico (properties.mode); fallback 'bus'.
        const m = String(f.properties['mode'] ?? 'bus') as 'bus' | 'metro' | 'tram';
        f.properties['mode'] = m;
        if (m === 'bus' || m === 'metro' || m === 'tram') modesPresent.add(m);
        merged.push(f);
      }

      // Calcolo delle fermate CONDIVISE: raggruppo per coordinata arrotondata
      // (5 decimali ~ 1 m) e, se sotto lo stesso punto ci sono piu' modi
      // diversi, marco ogni feature con properties.sharedModes (ordinati).
      const byKey = new Map<string, any[]>();
      for (const f of merged) {
        const c = f?.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        const key = `${Number(c[0]).toFixed(5)},${Number(c[1]).toFixed(5)}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(f);
      }
      byKey.forEach((group) => {
        const modes = Array.from(new Set(group.map((g) => g.properties['mode'])));
        if (modes.length > 1) {
          const ordered = this.STOP_MODE_ORDER.filter((m) => modes.includes(m));
          for (const g of group) g.properties['sharedModes'] = ordered;
        }
      });

      // Aggiorno lo stato dei filtri modo in base ai modi realmente presenti.
      this.availableStopModes = this.STOP_MODE_ORDER.filter((m) => modesPresent.has(m));
      this.stopModeFilter = new Set(this.availableStopModes);

      const fc = { type: 'FeatureCollection', features: merged } as any;

      // PATCH-LUCA "z-order-panes": fermate nella pane piu' alta (stopsPane).
      const layer = L.geoJSON(fc, {
        pointToLayer: (f: any, latlng: any) => this.buildStopMarker(f, latlng),
        onEachFeature: (f: any, lyr: any) => {
          // PATCH-LUCA "stop-schedule-panel": click -> pannello orari settimanali.
          lyr.on('click', () => {
            this.zone.run(() => this.openStopSchedule(f));
          });
        },
      });

      layer.addTo(this.map);
      this.layerCache.set(l.id, layer);
      // Applico subito filtro-modo e tematizzazione correnti.
      this.applyStopModeFilter();
      // FIX-LUCA "reach-turn-on-from-off-2026-11-09" (richiesta Luca):
      // loadLayer e' ASINCRONO (fetch del geojson). Quando si sceglie
      // "walking reach (400m)" a layer SPENTO, onSelectStopTheme accende il
      // layer e chiama restyleStops()/syncReachBuffers() SUBITO, ma in quel
      // momento il layer non e' ancora in layerCache -> i buffer 400 m non
      // vengono creati (si vedeva solo il layer normale). Qui, appena il
      // fetch e' completato e il layer e' in cache, richiamo restyleStops():
      // se la tematizzazione attiva e' 'reach' disegna finalmente i cerchi
      // da 400 m; per tutte le altre modalita' la chiamata e' innocua
      // (ri-applica lo stile gia' corretto).
      this.restyleStops();
      this.cdr.detectChanges();
    }).catch((err) => {
      console.error(`Errore caricamento ${l.label} (multimode):`, err);
    });
  }

  /**
   * PATCH-LUCA "stops-multimode": costruisce il marker di una fermata.
   * - Se e' condivisa (piu' modi sotto lo stesso punto) e siamo in tema 'mode',
   *   crea un pallino BICOLORE via divIcon (gradiente conic tra i colori modo).
   * - Altrimenti usa il circleMarker classico con colore/raggio da stopVisual().
   * Rispetta il filtro-modo: se nessuno dei modi della fermata e' acceso,
   *   il marker viene comunque creato ma nascosto da applyStopModeFilter().
   */
  private buildStopMarker(f: any, latlng: any): L.Layer {
    const shared = this.isSharedStop(f);
    // Pallino bicolore SOLO quando tematizziamo per modo (service type):
    // negli altri temi la fermata condivisa segue lo stile del tema attivo.
    if (shared && this.stopThemeMode === 'mode') {
      const modes: string[] = f.properties['sharedModes'];
      const colors = modes.map((m) => this.colorForMode(m));
      const n = colors.length;
      // Costruisco un conic-gradient a spicchi uguali.
      const stops: string[] = [];
      for (let i = 0; i < n; i++) {
        const from = (100 / n) * i;
        const to = (100 / n) * (i + 1);
        stops.push(`${colors[i]} ${from}% ${to}%`);
      }
      const size = 16;
      const html =
        `<div style="width:${size}px;height:${size}px;border-radius:50%;` +
        `background:conic-gradient(${stops.join(',')});` +
        `border:1.4px solid #4a0e63;box-shadow:0 0 0 0.5px rgba(0,0,0,0.15);"></div>`;
      const icon = L.divIcon({
        className: 'stop-shared-icon',
        html,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      return L.marker(latlng, { pane: 'stopsPane', icon });
    }

    // Marker classico (circleMarker) con lo stile del tema attivo.
    const v = this.stopVisual(f);
    const stroke = this.stopThemeMode === 'uniform'
      ? this.STOP_UNIFORM.stroke
      : this.darkenHex(v.color, 0.15);
    return L.circleMarker(latlng, {
      pane: 'stopsPane',
      radius: v.radius,
      fillColor: v.color,
      color: stroke,
      weight: 1.2,
      fillOpacity: 0.90,
      opacity: 1,
    });
  }

  /** Ritorna i modi di una fermata (sharedModes se condivisa, altrimenti [mode]). */
  private stopModesOf(f: any): string[] {
    const sm = f?.properties?.['sharedModes'];
    if (Array.isArray(sm) && sm.length) return sm;
    const m = f?.properties?.['mode'];
    return m ? [m] : [];
  }

  /**
   * PATCH-LUCA "stops-multimode": applica il filtro Bus/Metro/Tram.
   * Una fermata resta visibile se ALMENO UNO dei suoi modi e' acceso.
   * I marker filtrati vengono rimossi dalla mappa (senza distruggerli),
   * quelli attivi vengono riaggiunti.
   */
  private applyStopModeFilter(): void {
    const layer = this.layerCache.get('stops_clipped') as any;
    if (!layer) return;
    layer.eachLayer((lyr: any) => {
      const f = lyr?.feature;
      if (!f) return;
      const modes = this.stopModesOf(f);
      const visible = modes.some((m) => this.stopModeFilter.has(m as any));
      if (visible) {
        if (!this.map.hasLayer(lyr)) this.map.addLayer(lyr);
      } else {
        if (this.map.hasLayer(lyr)) this.map.removeLayer(lyr);
      }
    });
  }

  /**
   * PATCH-LUCA "stops-multimode": toggle di un checkbox modo (Bus/Metro/Tram).
   * Aggiorna il set stopModeFilter e riapplica il filtro sulla mappa.
   */
  toggleStopMode(mode: 'bus' | 'metro' | 'tram', ev: Event): void {
    const checked = (ev.target as HTMLInputElement)?.checked;
    if (checked) this.stopModeFilter.add(mode);
    else this.stopModeFilter.delete(mode);
    this.applyStopModeFilter();
    // FIX-LUCA "reach-respect-mode-filter-2026-11-09" (richiesta Luca): se la
    // tematizzazione attiva e' "walking reach (400m)", i pallini sono nascosti
    // e cio' che si vede sono i BUFFER da 400 m (reachBuffersGroup), che
    // applyStopModeFilter NON tocca. Ricostruisco i buffer con syncReachBuffers
    // cosi' rispettano il nuovo filtro Bus/Metro/Tram (i cerchi delle fermate
    // del modo spento spariscono, quelli dei modi accesi restano).
    if (this.stopThemeMode === 'reach') {
      this.syncReachBuffers();
    }
  }

  /** True se il modo indicato e' attualmente acceso. */
  isStopModeOn(mode: 'bus' | 'metro' | 'tram'): boolean {
    return this.stopModeFilter.has(mode);
  }

  /**
   * PATCH-LUCA "stops-multimode": wrapper PUBBLICO di colorForMode (private),
   * usato dal template per colorare il pallino accanto al checkbox del modo.
   */
  colorForModePublic(mode: string): string {
    return this.colorForMode(mode);
  }

  /**
   * PATCH-LUCA "stops-multimode-legend": true se almeno un modo di trasporto
   * e' attualmente acceso tra quelli disponibili in citta'. Usato dal template
   * per mostrare la legenda "Active service types" solo quando serve.
   */
  hasActiveStopModes(): boolean {
    return this.availableStopModes.some((m) => this.isStopModeOn(m));
  }

  private removeLayer(id: string): void {
    const layer = this.layerCache.get(id);
    if (layer) {
      this.map.removeLayer(layer);
      this.layerCache.delete(id);
    }
    // PATCH-LUCA "ghsl-pop-tileserver": se e' un layer XYZ da tile server
    // esterno (non e' in layerCache), lo rimuovo dalla mappa.
    if (this.xyzTileLayers.has(id)) {
      this.removeXyzTileLayer(id);
    }
    // PATCH-LUCA "freq-raster-overlay": togliendo il layer "Heatmap frequency"
    // (anche per mutua esclusivita' con Transport lines) rimuovo pure il
    // raster PNG sovrapposto, cosi' non resta orfano in mappa.
    if (id === 'heatmap_lines_freq') {
      this.removeFreqRasterOverlay();
      // PATCH-LUCA "freq-raster-cells-click": rimuovo anche le celle cliccabili.
      this.removeFreqCellsLayer();
    }
    // FIX-LUCA "reach-buffers-off-with-layer-2026-11-09" (richiesta Luca):
    // togliendo il layer Transport stop dalla mappa rimuovo SEMPRE anche i
    // buffer da 400 m ("walking reach"), cosi' non restano orfani quando il
    // layer viene spento mentre la tematizzazione "walking reach (400m)" e'
    // attiva. Rimozione di sicurezza: vale per qualunque percorso arrivi qui.
    if (id === 'stops_clipped' && this.reachBuffersGroup) {
      this.map.removeLayer(this.reachBuffersGroup);
      this.reachBuffersGroup.clearLayers();
      this.reachBuffersGroup = null;
    }
    // NB: NON tocchiamo ne' center ne' zoom -> la view rimane esattamente com'era
  }

  // === Styling poligoni per categoria attiva ===
  // PATCH-LUCA "hex-style-align-embedded":
  // Replica 1:1 lo stile del dashboard_embedded.html (funzione getColor +
  // stile hex). Regole:
  //   - val nullo/mancante  -> fill grigio chiaro trasparente (feature "vuota")
  //   - val > 60            -> fill e stroke = #9ca3af (grigio)
  //   - altrimenti          -> fill = interpolazione COLOR_STOPS
  //   - IL CONTORNO E' SEMPRE UGUALE AL FILL (non piu' viola).
  //   - weight = 1, lineJoin = 'round'.
  // PATCH-LUCA "hex-opacity-minus20":
  //   Opacita' abbassata del 20% rispetto alla versione precedente:
  //     fillOpacity: 0.75 -> 0.60   (0.75 * 0.80)
  //     opacity   : 0.60 -> 0.48   (0.60 * 0.80)
  //     null-fill : 0.25 -> 0.20   (0.25 * 0.80)
  //     null-strk : 0.40 -> 0.32   (0.40 * 0.80)
  private styleForPolygon(f: any): L.PathOptions {
    const cat = this.categories.find((c) => c.id === this.activeCategory);
    const prop = cat?.prop ?? 'overall_average';
    const rawVal = f?.properties ? f.properties[prop] : null;
    const val = this.parseMinutes(rawVal);

    // feature senza valore per questa categoria
    // PATCH-LUCA "transport-cells-uniform-opacity-2026-08-24" (richiesta Luca):
    // TUTTE le celle devono avere la STESSA trasparenza (bassa), non alcune piene e
    // altre trasparenti. Uso lo stesso valore del ramo "con valore" (0.18) per fill e
    // stroke, cosi' ogni esagono ha resa identica.
    if (val == null) {
      return {
        color: '#cccccc',
        weight: 1,
        fillColor: '#cccccc',
        // PATCH-LUCA "transport-opacity-slider-2026-09-09": opacita' regolabile
        // dallo slider in legenda (default 0.281). fill e stroke alla stessa opacita'.
        fillOpacity: this.transportOpacity,
        opacity: this.transportOpacity,
        lineJoin: 'round',
      };
    }

    // val > 60 -> grigio (come dashboard_embedded: getColor ritorna #9ca3af)
    const fill = val > 60 ? '#9ca3af' : this.colorForMinutes(val);
    return {
      color: fill,             // <- STROKE = FILL (non piu' viola)
      weight: 1,
      fillColor: fill,
      // PATCH-LUCA "polygons-opacity-40-2026-08-06" (richiesta Luca): opacita'
      // del layer "Transport stop accessability" (esagoni 15-min) portata al 40%
      // (fillOpacity 0.60 -> 0.40). Piu' trasparente: si vede meglio la basemap
      // ortofoto sotto. Lo stroke resta proporzionato (opacity ~0.32).
      // PATCH-LUCA "transport-cells-uniform-opacity-2026-08-24" (richiesta Luca): tutte
      // le celle stessa trasparenza bassa e uniforme. fill e stroke alla STESSA opacita'
      // (0.18) cosi' non ci sono celle che appaiono piene mentre altre trasparenti.
      // PATCH-LUCA "transport-opacity-slider-2026-09-09": opacita' regolabile dallo
      // slider in legenda (default 0.281). fillOpacity e opacity seguono lo slider.
      fillOpacity: this.transportOpacity,
      opacity: this.transportOpacity,
      lineJoin: 'round',
    };
  }

  private parseMinutes(v: any): number | null {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    // PATCH-LUCA "parse-out-of-range":
    // Nel geojson molti campi (education, health, park, postbank, overall_max)
    // sono stringhe. In particolare i valori "fuori scala" vengono salvati
    // come '> 60' / '>60' / '> 60 min'. Prima:
    //   '> 60'.replace('>','').trim() -> '60' -> parseFloat -> 60
    //   60 non e' > 60, quindi colorForMinutes(60) -> #7f1d1d (rosso vinaccia)
    //   -> TUTTI i poligoni "> 60" apparivano viola/vinaccia scurissimo invece
    //      del grigio previsto per "oltre soglia".
    // Ora: se la stringa contiene '>' restituiamo un valore > 60 (61) cosi'
    // il ramo val > 60 in styleForPolygon dipinge il poligono di grigio
    // (#9ca3af), coerentemente con la legenda "Walking time".
    const raw = String(v).trim().toLowerCase();
    const hasGt = raw.includes('>');
    const hasLt = raw.includes('<');
    const s = raw.replace('>', '').replace('<', '').replace('min', '').trim();
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    if (hasGt) return n + 0.5;   // "> 60" -> 60.5 (fuori scala -> grigio)
    if (hasLt) return Math.max(0, n - 0.5);
    return n;
  }

  private colorForMinutes(m: number): string {
    const stops = this.COLOR_STOPS_15;
    for (let i = 0; i < stops.length - 1; i++) {
      const [x0, c0] = stops[i];
      const [x1, c1] = stops[i + 1];
      if (m >= x0 && m <= x1) {
        const t = (m - x0) / (x1 - x0 || 1);
        return this.lerpColor(c0, c1, t);
      }
    }
    return stops[stops.length - 1][1];
  }

  private lerpColor(a: string, b: string, t: number): string {
    const ah = a.replace('#', '');
    const bh = b.replace('#', '');
    const ar = parseInt(ah.substring(0, 2), 16);
    const ag = parseInt(ah.substring(2, 4), 16);
    const ab = parseInt(ah.substring(4, 6), 16);
    const br = parseInt(bh.substring(0, 2), 16);
    const bg = parseInt(bh.substring(2, 4), 16);
    const bb = parseInt(bh.substring(4, 6), 16);
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `rgb(${rr},${rg},${rb})`;
  }

  private normalizeColor(c: string): string {
    if (!c) return '#53006c';
    const s = String(c).trim();
    if (s.startsWith('#')) return s;
    if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s;
    return s;
  }

  // PATCH-LUCA "stops-stroke-darker":
  // Restituisce una versione piu' scura di un colore hex (#RRGGBB), riducendo
  // la luminosita' HSL di 'amount' (0..1). Usata per il contorno dei
  // circleMarker delle fermate: stroke = fill leggermente piu' scuro.
  private darkenHex(hex: string, amount: number): string {
    const h = this.normalizeColor(hex).replace('#', '');
    if (h.length !== 6) return '#' + h;
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let hh = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: hh = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: hh = ((b - r) / d + 2); break;
        case b: hh = ((r - g) / d + 4); break;
      }
      hh /= 6;
    }
    const newL = Math.max(0, Math.min(1, l - amount));
    // HSL -> RGB
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let nr: number, ng: number, nb: number;
    if (s === 0) {
      nr = ng = nb = newL;
    } else {
      const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s;
      const p = 2 * newL - q;
      nr = hue2rgb(p, q, hh + 1 / 3);
      ng = hue2rgb(p, q, hh);
      nb = hue2rgb(p, q, hh - 1 / 3);
    }
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + toHex(nr) + toHex(ng) + toHex(nb);
  }

  // PATCH-LUCA "pretty-popups": popup informativi e curati, uno per ogni layer.
  // Ogni layer ha un popup dedicato (titolo + valore in evidenza + dettagli),
  // invece del dump grezzo "chiave: valore". Il layer "Transport stop" NON passa
  // di qui (ha gia' il pannello orario laterale).
  //   - heatmap_lines_livery -> scheda linea (numero, tratta, gestore, capolinea, frequenza)
  //   - heatmap_lines_freq   -> focus sulla frequenza (corse/giorno) + tratta
  //   - pop_coverage_map     -> % popolazione coperta (NIENTE 'pop', e' sempre null)
  //   - transit_deserts      -> abitanti non serviti in quella cella
  //   - leuven_15min_transport -> score di accessibilita' 15-min
  private bindPopup(f: any, lyr: L.Layer, layerId?: string): void {
    if (!f?.properties) return;
    const html = this.buildPopupHtml(f.properties, layerId);
    // PATCH-LUCA "transport-cells-clickable-any-zoom-2026-09-04" (richiesta Luca):
    // il popup dell'esagono "Transport stop accessibility" (transport_15min) deve
    // aprirsi CLICCANDO A QUALSIASI ALTEZZA/ZOOM, non solo da molto zoommato. E'
    // stato quindi RIMOSSO il vincolo POLY_CLICK_MIN_ZOOM (che sotto zoom 15
    // chiudeva il popup e bloccava il click). Ora tutti i layer, incluso
    // transport_15min, aprono il popup con un normale bindPopup.
    (lyr as any).bindPopup(html, { className: 'lz-popup', maxWidth: 300 });
  }

  /** Costruisce l'HTML del popup in base al layer. Card uniforme e leggibile. */
  private buildPopupHtml(p: any, layerId?: string): string {
    const esc = (v: any) =>
      v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const num = (v: any) => {
      const n = typeof v === 'number' ? v : parseFloat(v);
      return isNaN(n) ? null : n;
    };
    // Wrapper card + helper per le righe
    const card = (title: string, accent: string, bodyRows: string) => `
      <div class="lzp" style="font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;min-width:180px">
        <div class="lzp-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="width:10px;height:10px;border-radius:50%;background:${accent};flex:0 0 auto;box-shadow:0 0 0 3px ${accent}22"></span>
          <span style="font-weight:700;color:#1f2937;letter-spacing:.2px">${title}</span>
        </div>
        ${bodyRows}
      </div>`;
    // Riga "etichetta -> valore"
    const row = (label: string, value: string) =>
      value === '' || value == null
        ? ''
        : `<div style="display:flex;justify-content:space-between;gap:14px;padding:2px 0">
             <span style="color:#6b7280">${label}</span>
             <span style="color:#111827;font-weight:600;text-align:right">${value}</span>
           </div>`;
    // Blocco "numero grande" in evidenza
    const hero = (value: string, unit: string, accent: string) => `
      <div style="display:flex;align-items:baseline;gap:6px;margin:2px 0 8px">
        <span style="font-size:26px;font-weight:800;color:${accent};line-height:1">${value}</span>
        <span style="font-size:12px;color:#6b7280">${unit}</span>
      </div>`;

    // ---- TRANSPORT LINES (livery) ----
    if (layerId === 'heatmap_lines_livery') {
      const color = /^#/.test(String(p.color)) ? p.color : '#2563eb';
      const lineBadge = p.line
        ? `<span style="display:inline-block;min-width:20px;text-align:center;background:${color};color:#fff;font-weight:800;border-radius:6px;padding:1px 8px;margin-right:6px">${esc(p.line)}</span>`
        : '';
      const title = `${lineBadge}Line ${esc(p.line)}`;
      const freq = num(p.frequency);
      return card(title, color,
        row('Route', esc(p.name || p.route_desc)) +
        row('Operator', esc(p.agency)) +
        row('Destination', esc(p.destination)) +
        (freq != null ? row('Trips/week', freq.toLocaleString('en-US')) : '') +
        row('Service window', p.start_time && p.end_time
          ? `${esc(String(p.start_time).slice(11, 16))}–${esc(String(p.end_time).slice(11, 16))}`
          : '')
      );
    }

    // ---- HEATMAP FREQUENCY ----
    if (layerId === 'heatmap_lines_freq') {
      const freq = num(p.frequency);
      const accent = '#c026d3';
      return card('Service frequency', accent,
        (freq != null ? hero(freq.toLocaleString('en-US'), 'trips / week', accent) : '') +
        row('Line', esc(p.line)) +
        row('Route', esc(p.name || p.route_desc)) +
        row('Destination', esc(p.destination))
      );
    }

    // ---- POPULATION COVERAGE ----
    // PATCH-LUCA "coverage-pop-counts" (richiesta Luca): oltre alla percentuale
    // di copertura mostro anche il NUMERO REALE di residenti della cella, quanti
    // coperti e quanti scoperti. I campi pop_tot / pop_covered / pop_uncovered
    // sono calcolati offline dallo step 05b della pipeline (join spaziale delle
    // celle di popolazione GHSL 2025 dentro le celle coverage). Se non presenti
    // (dati vecchi), il popup mostra solo la percentuale come prima.
    if (layerId === 'pop_coverage_map') {
      const pct = num(p.pct_covered);
      const accent = '#7c3aed';
      const pctTxt = pct != null ? `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}` : '—';
      const popTot = num(p.pop_tot);
      const popCov = num(p.pop_covered);
      const popUnc = num(p.pop_uncovered);
      const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString('en-US'));
      return card('Population coverage', accent,
        hero(pctTxt + '%', 'residents covered', accent) +
        (popTot != null ? row('Residents', fmt(popTot)) : '') +
        (popCov != null ? row('Covered', fmt(popCov)) : '') +
        (popUnc != null ? row('Uncovered', fmt(popUnc)) : '') +
        `<div style="font-size:12px;color:#6b7280;margin-top:4px">Share of this cell's residents reachable by transit within 15 minutes.</div>`
      );
    }

    // ---- TRANSIT DESERTS ----
    if (layerId === 'transit_deserts') {
      const pop = num(p.pop);
      const accent = '#dc2626';
      return card('Transit desert', accent,
        (pop != null ? hero(pop.toLocaleString('en-US'), pop === 1 ? 'resident stranded' : 'residents stranded', accent) : '') +
        `<div style="font-size:12px;color:#6b7280">People here lack usable public-transport access.</div>`
      );
    }

    // ---- 15-MIN POLYGONS ----
    // PATCH-LUCA "transport-infobox-minutes-2026-09-04" (richiesta Luca): il popup
    // dell'esagono "Transport stop accessibility" mostra ora, al posto dello
    // "accessibility score", il valore in MINUTI (campo transport_stop = minuti a
    // piedi alla fermata piu' vicina). Titolo: "transport stop accessibility",
    // numero grande = i minuti, unita' = "minuti". Nessuna descrizione aggiuntiva.
    if (layerId === 'transport_15min') {
      const minutes = num(p.transport_stop);
      const accent = '#0891b2';
      return card('transport stop accessibility', accent,
        (minutes != null ? hero(String(minutes), 'minuti', accent) : '')
      );
    }

    // ---- FALLBACK generico (ma pulito): salta valori vuoti/null ----
    const rows = Object.entries(p)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, 10)
      .map(([k, v]) => row(esc(k), esc(v)))
      .join('');
    return card('Details', '#2563eb', rows);
  }

  // ==========================================================================
  // PATCH-LUCA "basemap-dropdown": metodi per gestire il pulsante tondo
  // in alto a destra e il dropdown con 4 opzioni di basemap.
  // ==========================================================================

  /** Apre/chiude il dropdown delle basemap. Chiamato dal click sul pulsante tondo. */
  toggleBasemapMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.basemapMenuOpen = !this.basemapMenuOpen;
  }

  /** Chiude il dropdown se l'utente clicca in un punto qualsiasi FUORI dal .basemap-switcher. */
  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.basemapMenuOpen) this.basemapMenuOpen = false;
  }

  /** Callback click su una delle 4 opzioni: applica la basemap.
   *  PATCH-LUCA "keep-dropdown-open-on-select":
   *  il menu NON si chiude piu' quando si seleziona una basemap.
   *  Resta aperto finche' l'utente:
   *    - clicca in un punto qualsiasi FUORI dal .basemap-switcher
   *      (gestito da @HostListener('document:click'))
   *    - oppure riclicca sull'icona principale
   *      (gestito da toggleBasemapMenu -> flip di basemapMenuOpen)
   *  Cosi' l'utente puo' provare rapidamente piu' basemap senza dover
   *  riaprire il dropdown ogni volta. */
  selectBasemap(id: string): void {
    if (id === this.activeBasemapId) return;
    this.applyBasemap(id);
    // NB: NON chiudiamo piu' il dropdown qui.
  }

  /**
   * Rimuove l'eventuale basemap corrente e aggiunge quella richiesta.
   * Il tileLayer viene inserito nel pane 'tilePane' (zIndex 200), sotto
   * i pane custom polygonsPane/linesPane/stopsPane (410/420/430).
   */
  private applyBasemap(id: string): void {
    const b = this.basemaps.find(x => x.id === id);
    if (!b || !this.map) return;

    // Rimuovi il tileLayer precedente (se presente)
    if (this.basemapLayer) {
      this.map.removeLayer(this.basemapLayer);
      this.basemapLayer = undefined;
    }

    // Aggiungi il nuovo tileLayer
    this.basemapLayer = L.tileLayer(b.urlTemplate, b.options).addTo(this.map);
    this.activeBasemapId = id;
  }
}
