const express = require('express');
const { getTryOnConfig, validateTryOnInput, generateTryOn, TryOnError } = require('../services/tryOnService');
const { assertDeviceId, PaymentError } = require('../services/paymentService');
const { consumeTryOnCredit } = require('../services/googlePlayService');

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
    // A server-side payment credit, tied to this app installation, gates each
    // billable Fal generation. No provider key or private beta code reaches the app.
    try { assertDeviceId(req.auth?.subject); } catch (error) {
      if (error instanceof PaymentError) return res.status(error.status).json({ code: error.code, message: error.message });
      return res.status(400).json({ code: 'INVALID_DEVICE', message: 'This device could not be identified. Reopen the app and try again.' });
    }
    if (req.get('X-Photo-Consent') !== 'fal-photos-v1') {
      return res.status(400).json({ code: 'CONSENT_REQUIRED', message: 'Confirm photo processing before generating a preview.' });
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
      // Validate the local request first; malformed photos must never consume a
      // paid credit. A credit is consumed immediately before the Fal request.
      validateTryOnInput(req.body);
      const creditsRemaining = await consumeTryOnCredit(req.auth.subject, { env, fetchImpl });
      const result = await generateTryOn(req.body, { env, fetchImpl, timeoutMs, signal: controller.signal });
      if (!res.destroyed) res.json({ ...result, creditsRemaining });
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof TryOnError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      if (error instanceof PaymentError) {
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
