require('dotenv').config();
const express = require('express');
const cors = require('cors');

const wardrobeRoutes = require('./routes/wardrobe');
const outfitRoutes = require('./routes/outfit');
const { createTryOnRouter } = require('./routes/tryOn');
const { createPaymentsRouter } = require('./routes/payments');

const app = express();
app.use(cors());
app.use('/api/payments', createPaymentsRouter());
app.use('/api/try-on', createTryOnRouter());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/wardrobe', wardrobeRoutes);
app.use('/api/outfit', outfitRoutes);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Wardrobe AI backend running on port ${PORT}`));
}

module.exports = app;
