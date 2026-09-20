const express = require('express');
const { PaymentError, getPaymentConfig, assertDeviceId, getCredits, createOrder, verifyPayment } = require('../services/paymentService');

function createPaymentsRouter({ env = process.env, fetchImpl = global.fetch } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const deviceId = (req) => assertDeviceId(req.auth?.subject);

  router.get('/config', (req, res) => res.json(getPaymentConfig(env)));
  router.get('/credits', async (req, res, next) => {
    try { res.json({ creditsRemaining: await getCredits(deviceId(req), { env, fetchImpl }) }); } catch (error) { next(error); }
  });
  router.post('/orders', express.json({ limit: '8kb', inflate: false }), async (req, res, next) => {
    try { res.status(201).json(await createOrder({ deviceId: deviceId(req), planId: req.body?.planId }, { env, fetchImpl })); } catch (error) { next(error); }
  });
  router.post('/verify', express.json({ limit: '8kb', inflate: false }), async (req, res, next) => {
    try {
      const body = req.body || {};
      res.json(await verifyPayment({ deviceId: deviceId(req), orderId: body.orderId, paymentId: body.paymentId, signature: body.signature }, { env, fetchImpl }));
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (error instanceof PaymentError) return res.status(error.status).json({ code: error.code, message: error.message });
    res.status(400).json({ code: 'INVALID_PAYMENT_REQUEST', message: 'The payment request could not be read.' });
  });
  return router;
}

module.exports = { createPaymentsRouter };
