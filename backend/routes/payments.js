const express = require('express');
const { PaymentError, assertDeviceId } = require('../services/paymentService');
const { getPaymentConfig, getCredits, verifyPurchase, accountId } = require('../services/googlePlayService');

function createPaymentsRouter({ env = process.env, fetchImpl = global.fetch } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const deviceId = (req) => assertDeviceId(req.auth?.subject);

  router.get('/config', (req, res) => res.json(getPaymentConfig(env)));
  router.get('/credits', async (req, res, next) => {
    try { res.json({ creditsRemaining: await getCredits(deviceId(req), { env, fetchImpl }) }); } catch (error) { next(error); }
  });
  router.get('/google-play/account', (req, res, next) => {
    try { res.json({ obfuscatedAccountId: accountId(deviceId(req), env) }); } catch (error) { next(error); }
  });
  router.post('/google-play/verify', express.json({ limit: '8kb', inflate: false }), async (req, res, next) => {
    try {
      const body = req.body || {};
      res.json(await verifyPurchase({ deviceId: deviceId(req), productId: body.productId, purchaseToken: body.purchaseToken }, { env, fetchImpl }));
    } catch (error) { next(error); }
  });
  // Old clients cannot silently keep starting Razorpay purchases after rollout.
  router.post(['/orders', '/verify'], (req, res) => res.status(410).json({ code: 'APP_UPDATE_REQUIRED', message: 'Update the app to use Google Play purchases.' }));
  router.use((error, req, res, next) => {
    if (error instanceof PaymentError) return res.status(error.status).json({ code: error.code, message: error.message });
    res.status(400).json({ code: 'INVALID_PAYMENT_REQUEST', message: 'The payment request could not be read.' });
  });
  return router;
}

module.exports = { createPaymentsRouter };
