const express = require('express');
const { generateOutfit } = require('../services/aiService');

const router = express.Router();

// POST /api/outfit/generate  { items, occasion, weather }
router.post('/generate', async (req, res) => {
  try {
    const { items, occasion, weather } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No wardrobe items provided' });
    }
    const text = (value, max) => typeof value === 'string' && value.length <= max;
    if (items.length > 100 || !text(occasion, 200) || !text(weather, 200) || items.some(item =>
      !item || !text(item.id, 100) || !text(item.category, 50) || !text(item.color, 100) ||
      !text(item.season, 50) || !Array.isArray(item.tags) || item.tags.length > 20 ||
      item.tags.some(tag => !text(tag, 50)))) {
      return res.status(400).json({ error: 'Wardrobe details are invalid or too large.' });
    }
    const result = await generateOutfit({ items, occasion, weather });
    res.json(result);
  } catch (err) {
    // Never log raw provider errors or wardrobe content.
    res.status(500).json({ error: 'Failed to generate outfit' });
  }
});

module.exports = router;
