const { createHmac, timingSafeEqual } = require('node:crypto');
const { getPaymentStore } = require('./mongoPaymentStore');

const PLANS = Object.freeze({
  starter: Object.freeze({ id: 'starter', label: 'Starter', amount: 25000, credits: 1 }),
  standard: Object.freeze({ id: 'standard', label: 'Standard', amount: 50000, credits: 3 }),
  premium: Object.freeze({ id: 'premium', label: 'Premium', amount: 100000, credits: 10 }),
});
const DEVICE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getPaymentConfig(env = process.env) {
  const configured = Boolean(
    env.RAZORPAY_KEY_ID?.trim() &&
    env.RAZORPAY_KEY_SECRET?.trim() &&
    env.MONGODB_URI?.trim(),
  );
  return configured
    ? { available: true, provider: 'razorpay', currency: 'INR', plans: Object.values(PLANS).map(({ id, label, amount, credits }) => ({ id, label, amount, credits })) }
    : { available: false, provider: 'razorpay', currency: 'INR', code: 'PAYMENTS_NOT_CONFIGURED', message: 'Payments are not configured yet.' };
}

function assertConfigured(env) {
  const config = getPaymentConfig(env);
  if (!config.available) throw new PaymentError(503, config.code, config.message);
  return config;
}

function assertDeviceId(value) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new PaymentError(400, 'INVALID_DEVICE', 'This device could not be identified. Reopen the app and try again.');
  }
  return value.toLowerCase();
}

function assertPlan(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PLANS, value)) {
    throw new PaymentError(400, 'INVALID_PLAN', 'Choose one of the available try-on packs.');
  }
  return PLANS[value];
}

async function withStore(options, operation) {
  try {
    return await operation(options.store || await getPaymentStore(options.env || process.env));
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    // Driver errors may contain hostnames/credentials; never return them.
    throw new PaymentError(503, 'CREDITS_UNAVAILABLE', 'Your try-on balance is temporarily unavailable. Please try again later.');
  }
}

async function getCredits(deviceId, options = {}) {
  assertConfigured(options.env || process.env);
  const device = assertDeviceId(deviceId);
  const result = await withStore(options, store => store.getCredits(device));
  const credits = Number(result || 0);
  return Number.isSafeInteger(credits) && credits > 0 ? credits : 0;
}

async function createOrder({ deviceId, planId }, { env = process.env, fetchImpl = global.fetch, store } = {}) {
  assertConfigured(env);
  const device = assertDeviceId(deviceId);
  const plan = assertPlan(planId);
  // Check database access before creating an external payment order.
  store = await withStore({ env, store }, value => value);
  const authorization = Buffer.from(`${env.RAZORPAY_KEY_ID.trim()}:${env.RAZORPAY_KEY_SECRET.trim()}`).toString('base64');
  let response;
  try {
    response = await fetchImpl('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: plan.amount, currency: 'INR', receipt: `wardrobe_${Date.now()}`, notes: { product: 'wardrobe_try_on', plan: plan.id, credits: String(plan.credits) } }),
    });
  } catch {
    throw new PaymentError(503, 'PAYMENT_UNAVAILABLE', 'UPI checkout is temporarily unavailable. Please try again later.');
  }
  if (!response.ok) throw new PaymentError(503, 'PAYMENT_UNAVAILABLE', 'UPI checkout is temporarily unavailable. Please try again later.');
  const order = await response.json();
  if (typeof order?.id !== 'string' || order.amount !== plan.amount || order.currency !== 'INR') {
    throw new PaymentError(502, 'PAYMENT_UNAVAILABLE', 'Could not prepare this UPI payment. Please try again.');
  }
  const record = { deviceId: device, planId: plan.id, credits: plan.credits, amount: plan.amount, currency: 'INR' };
  await withStore({ env, store }, value => value.createOrder(order.id, record));
  return { orderId: order.id, keyId: env.RAZORPAY_KEY_ID.trim(), amount: plan.amount, currency: 'INR', plan: { id: plan.id, label: plan.label, credits: plan.credits } };
}

function signatureMatches(orderId, paymentId, signature, secret) {
  if (![orderId, paymentId, signature, secret].every(value => typeof value === 'string' && value.length > 0)) return false;
  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function verifyPayment({ deviceId, orderId, paymentId, signature }, { env = process.env, store } = {}) {
  assertConfigured(env);
  const device = assertDeviceId(deviceId);
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
    throw new PaymentError(400, 'INVALID_PAYMENT', 'The payment confirmation could not be read.');
  }
  store = await withStore({ env, store }, value => value);
  const order = await withStore({ env, store }, value => value.getOrder(orderId));
  if (!order) throw new PaymentError(400, 'PAYMENT_NOT_VERIFIED', 'This payment order could not be found. No try-on credits were added.');
  if (order?.deviceId !== device || !Number.isSafeInteger(order?.credits) || order.credits < 1 || order.credits > 10 || !signatureMatches(orderId, paymentId, signature, env.RAZORPAY_KEY_SECRET.trim())) {
    throw new PaymentError(400, 'PAYMENT_NOT_VERIFIED', 'The payment could not be verified. No try-on credits were added.');
  }
  await withStore({ env, store }, value => value.activateOrder(orderId, device, paymentId, order.credits));
  const remaining = await getCredits(device, { env, store });
  return { creditsRemaining: Math.max(0, Number(remaining) || 0) };
}

async function consumeTryOnCredit(deviceId, options = {}) {
  const device = assertDeviceId(deviceId);
  assertConfigured(options.env || process.env);
  const consumed = await withStore(options, store => store.consumeCredit(device));
  if (!consumed) throw new PaymentError(402, 'CREDITS_REQUIRED', 'Purchase a try-on pack before generating a preview.');
  return getCredits(device, options);
}

module.exports = { PLANS, PaymentError, getPaymentConfig, assertDeviceId, getCredits, createOrder, verifyPayment, consumeTryOnCredit };
