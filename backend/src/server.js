const express = require('express');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const geoRoutes = require('./routes/geo.routes');
const gtfsRoutes = require('./routes/gtfs.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Percorso assoluto della cartella data (fuori da dashboard/)
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

// Middleware globali
app.use(cors());
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));

// Rende il path della data disponibile alle route
app.locals.DATA_DIR = DATA_DIR;

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'leuven-15min-backend',
    dataDir: DATA_DIR,
    timestamp: new Date().toISOString()
  });
});

// Route montate
app.use('/api/geo', geoRoutes);
app.use('/api/gtfs', gtfsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message || 'Errore interno' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Backend Leuven 15-min avviato su http://localhost:${PORT}`);
  console.log(`📂 Data dir: ${DATA_DIR}\n`);
});
