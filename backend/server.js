require('dotenv').config();
const express = require('express');
const cors = require('cors');

const wardrobeRoutes = require('./routes/wardrobe');
const outfitRoutes = require('./routes/outfit');
<<<<<<< HEAD
const { createTryOnRouter } = require('./routes/tryOn');

const app = express();
app.use(cors());
app.use('/api/try-on', createTryOnRouter());
=======

const app = express();
app.use(cors());
>>>>>>> 61b8ef536785e623ebbe0c633b55f13aa576a28f
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/wardrobe', wardrobeRoutes);
app.use('/api/outfit', outfitRoutes);

const PORT = process.env.PORT || 3001;
<<<<<<< HEAD
if (require.main === module) {
  app.listen(PORT, () => console.log(`Wardrobe AI backend running on port ${PORT}`));
}

module.exports = app;
=======
app.listen(PORT, () => console.log(`Wardrobe AI backend running on port ${PORT}`));
>>>>>>> 61b8ef536785e623ebbe0c633b55f13aa576a28f
