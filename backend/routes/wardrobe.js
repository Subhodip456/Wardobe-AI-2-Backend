const express = require('express');
const multer = require('multer');
const { tagClothingImage } = require('../services/aiService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });

// POST /api/wardrobe/tag  (multipart/form-data, field name "image")
router.post('/tag', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const bytes = req.file.buffer;
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!(jpeg && req.file.mimetype === 'image/jpeg') && !(png && req.file.mimetype === 'image/png')) {
      return res.status(400).json({ error: 'Upload a JPEG or PNG image.' });
    }

    const base64 = req.file.buffer.toString('base64');
    const result = await tagClothingImage(base64, req.file.mimetype);
    res.json(result);
  } catch (err) {
    // Do not log SDK errors: they can contain user content or request metadata.
    res.status(500).json({ error: 'Failed to tag image' });
  }
});

module.exports = router;
