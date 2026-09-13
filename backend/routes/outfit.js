const express = require('express');
const { generateOutfit } = require('../services/aiService');

const router = express.Router();

// POST /api/outfit/generate  { items, occasion, weather }
router.post('/generate', async (req, res) => {
  try {
    const { items, occasion, weather } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No wardrobe items provided' });
    }
    const result = await generateOutfit({ items, occasion, weather });
    res.json(result);
  } catch (err) {
    console.error('Outfit generation error:', err);
    res.status(500).json({ error: 'Failed to generate outfit' });
  }
});

module.exports = router;
