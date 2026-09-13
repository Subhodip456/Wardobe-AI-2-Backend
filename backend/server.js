require('dotenv').config();
const express = require('express');
const cors = require('cors');

const wardrobeRoutes = require('./routes/wardrobe');
const outfitRoutes = require('./routes/outfit');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/wardrobe', wardrobeRoutes);
app.use('/api/outfit', outfitRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Wardrobe AI backend running on port ${PORT}`));
