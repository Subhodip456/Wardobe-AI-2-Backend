const express = require('express');
const multer = require('multer');
const { tagClothingImage } = require('../services/aiService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// POST /api/wardrobe/tag  (multipart/form-data, field name "image")
router.post('/tag', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const base64 = req.file.buffer.toString('base64');
    const result = await tagClothingImage(base64, req.file.mimetype);
    res.json(result);
  } catch (err) {
    console.error('Tagging error:', err);
    res.status(500).json({ error: 'Failed to tag image' });
  }
});

module.exports = router;
