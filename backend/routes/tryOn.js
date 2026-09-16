const express = require('express');
const { getTryOnConfig, validAccessToken, generateTryOn, TryOnError } = require('../services/tryOnService');

function createTryOnRouter({ env = process.env, fetchImpl = global.fetch, timeoutMs } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/config', (req, res) => res.json(getTryOnConfig(env)));

  router.post('/', (req, res, next) => {
    const config = getTryOnConfig(env);
    if (!config.available) return res.status(503).json({ code: config.code, message: config.message });
    // Authenticate before decoding a potentially large photo upload. Never embed this code in the app bundle.
    if (!validAccessToken(req.get('Authorization'), env.TRY_ON_ACCESS_TOKEN)) {
      return res.status(401).json({ code: 'ACCESS_CODE_REQUIRED', message: 'Enter the private try-on access code provided by the backend owner. Do not enter a Fal or other provider API key.' });
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ code: 'JSON_REQUIRED', message: 'Send the preview request as JSON.' });
    }
    next();
  }, express.json({ limit: '3.5mb', inflate: false }), async (req, res) => {
    const controller = new AbortController();
    const onDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);
    try {
      const result = await generateTryOn(req.body, { env, fetchImpl, timeoutMs, signal: controller.signal });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof TryOnError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      res.status(500).json({ code: 'TRY_ON_FAILED', message: 'Could not create your preview. Please try again later.' });
    } finally {
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
    }
  });

  router.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ code: 'UPLOAD_TOO_LARGE', message: 'These photos are too large. Choose smaller photos and try again.' });
    }
    if (error.type === 'encoding.unsupported') {
      return res.status(415).json({ code: 'ENCODING_UNSUPPORTED', message: 'Send an uncompressed JSON preview request.' });
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ code: 'INVALID_JSON', message: 'The preview request could not be read. Please choose the photos again.' });
    }
    // Do not return or log parser errors: their body may contain personal photos.
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'The preview request could not be read. Please try again.' });
  });

  return router;
}

module.exports = { createTryOnRouter };
