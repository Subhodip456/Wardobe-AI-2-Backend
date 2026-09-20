require('dotenv').config();
const express = require('express');
const cors = require('cors');

const wardrobeRoutes = require('./routes/wardrobe');
const outfitRoutes = require('./routes/outfit');
const { createTryOnRouter } = require('./routes/tryOn');
const { createPaymentsRouter } = require('./routes/payments');
const { securityMiddleware } = require('./routes/security');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  next();
});
const allowedOrigins = (process.env.ALLOWED_WEB_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Photo-Consent'] }));
app.use('/api', securityMiddleware());
app.use('/api/payments', createPaymentsRouter());
app.use('/api/try-on', createTryOnRouter());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/wardrobe', wardrobeRoutes);
app.use('/api/outfit', outfitRoutes);
app.use((error, req, res, next) => {
  res.status(error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    .json({ code: 'INVALID_REQUEST', message: 'The request could not be processed.' });
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Wardrobe AI backend running on port ${PORT}`));
}

module.exports = app;
