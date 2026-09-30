const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const router = express.Router();

/**
 * Endpoint: elenco dei layer GIS disponibili nella cartella data
 * GET /api/geo/layers
 */
router.get('/layers', (req, res) => {
  const dataDir = req.app.locals.DATA_DIR;
  try {
    const files = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name)
      .filter(name => /\.(gpkg|geojson|json)$/i.test(name));

    const layers = files.map(name => ({
      id: name.replace(/\.[^.]+$/, ''),
      file: name,
      type: name.endsWith('.geojson') || name.endsWith('.json') ? 'geojson' : 'gpkg',
      url: `/api/geo/layer/${name.replace(/\.[^.]+$/, '')}`
    }));

    res.json({ count: layers.length, layers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint: restituisce un layer come GeoJSON
 * GET /api/geo/layer/:id
 * - Se e' un .geojson lo serve direttamente
 * - Se e' un .gpkg tenta di leggerlo con better-sqlite3 come SQLite (GeoPackage)
 */
router.get('/layer/:id', (req, res) => {
  const dataDir = req.app.locals.DATA_DIR;
  const { id } = req.params;

  // Cerca il file matchando l'id (senza estensione)
  const files = fs.readdirSync(dataDir).filter(f => f.replace(/\.[^.]+$/, '') === id);
  if (files.length === 0) {
    return res.status(404).json({ error: `Layer '${id}' non trovato` });
  }

  const filename = files[0];
  const filepath = path.join(dataDir, filename);

  // Caso .geojson: serve direttamente
  if (/\.(geojson|json)$/i.test(filename)) {
    res.setHeader('Content-Type', 'application/geo+json');
    return fs.createReadStream(filepath).pipe(res);
  }

  // Caso .gpkg: legge come SQLite e restituisce metadata (per la geometria serve GDAL/ogr2ogr)
  if (/\.gpkg$/i.test(filename)) {
    try {
      const db = new Database(filepath, { readonly: true });
      const tables = db.prepare(`
        SELECT table_name, data_type, srs_id
        FROM gpkg_contents
      `).all();
      db.close();
      return res.json({
        file: filename,
        message: 'File GeoPackage. Per estrarre la geometria come GeoJSON usa ogr2ogr in preprocessing.',
        tables
      });
    } catch (err) {
      return res.status(500).json({ error: `Errore lettura GPKG: ${err.message}` });
    }
  }

  res.status(415).json({ error: 'Formato non supportato' });
});

module.exports = router;
