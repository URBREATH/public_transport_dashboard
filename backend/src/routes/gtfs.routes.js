const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const router = express.Router();

const GTFS_SUBDIR = 'delijn-gtfs';

/**
 * Helper: legge un file GTFS (formato .txt = CSV) e restituisce un array di oggetti
 * Supporta paginazione con limit/offset per file grandi (es. trips.txt, shapes.txt).
 */
function readGtfsCsv(filepath, { limit = 1000, offset = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    let currentIndex = 0;
    const stream = fs.createReadStream(filepath).pipe(csv());

    stream.on('data', (row) => {
      if (currentIndex >= offset && results.length < limit) {
        results.push(row);
      }
      currentIndex++;
      if (results.length >= limit) {
        stream.destroy();
      }
    });
    stream.on('close', () => resolve({ total: currentIndex, rows: results }));
    stream.on('end', () => resolve({ total: currentIndex, rows: results }));
    stream.on('error', reject);
  });
}

/**
 * GET /api/gtfs/files
 * Elenco dei file GTFS disponibili
 */
router.get('/files', (req, res) => {
  const gtfsDir = path.join(req.app.locals.DATA_DIR, GTFS_SUBDIR);
  try {
    const files = fs.readdirSync(gtfsDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        const stat = fs.statSync(path.join(gtfsDir, f));
        return { name: f, size: stat.size };
      });
    res.json({ dir: GTFS_SUBDIR, count: files.length, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gtfs/:file?limit=1000&offset=0
 * Restituisce paginato il contenuto di un file GTFS come JSON
 */
router.get('/:file', async (req, res) => {
  const { file } = req.params;
  const limit = parseInt(req.query.limit || '1000', 10);
  const offset = parseInt(req.query.offset || '0', 10);

  const safeName = file.endsWith('.txt') ? file : `${file}.txt`;
  const filepath = path.join(req.app.locals.DATA_DIR, GTFS_SUBDIR, safeName);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: `File '${safeName}' non trovato` });
  }

  try {
    const result = await readGtfsCsv(filepath, { limit, offset });
    res.json({ file: safeName, limit, offset, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
