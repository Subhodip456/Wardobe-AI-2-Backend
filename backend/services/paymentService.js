const { createHmac, timingSafeEqual } = require('node:crypto');

const PLANS = Object.freeze({
  starter: Object.freeze({ id: 'starter', label: 'Starter', amount: 25000, credits: 1 }),
  standard: Object.freeze({ id: 'standard', label: 'Standard', amount: 50000, credits: 3 }),
  premium: Object.freeze({ id: 'premium', label: 'Premium', amount: 100000, credits: 10 }),
});
const ORDER_TTL_SECONDS = 60 * 60 * 24;
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
    env.UPSTASH_REDIS_REST_URL?.trim() &&
    env.UPSTASH_REDIS_REST_TOKEN?.trim(),
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

function creditKey(deviceId) { return `wardrobe:try-on:credits:${deviceId}`; }
function orderKey(orderId) { return `wardrobe:payment:order:${orderId}`; }
function claimKey(orderId) { return `wardrobe:payment:claimed:${orderId}`; }

async function redisCommand(command, { env = process.env, fetchImpl = global.fetch } = {}) {
  const response = await fetchImpl(env.UPSTASH_REDIS_REST_URL.trim(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new PaymentError(503, 'CREDITS_UNAVAILABLE', 'Your try-on balance is temporarily unavailable. Please try again later.');
  const payload = await response.json();
  if (payload?.error) throw new PaymentError(503, 'CREDITS_UNAVAILABLE', 'Your try-on balance is temporarily unavailable. Please try again later.');
  return payload?.result;
}

async function getCredits(deviceId, options = {}) {
  const result = await redisCommand(['GET', creditKey(assertDeviceId(deviceId))], options);
  const credits = Number(result || 0);
  return Number.isSafeInteger(credits) && credits > 0 ? credits : 0;
}

async function createOrder({ deviceId, planId }, { env = process.env, fetchImpl = global.fetch } = {}) {
  assertConfigured(env);
  const device = assertDeviceId(deviceId);
  const plan = assertPlan(planId);
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
  const record = JSON.stringify({ deviceId: device, planId: plan.id, credits: plan.credits, amount: plan.amount });
  await redisCommand(['SET', orderKey(order.id), record, 'EX', ORDER_TTL_SECONDS], { env, fetchImpl });
  return { orderId: order.id, keyId: env.RAZORPAY_KEY_ID.trim(), amount: plan.amount, currency: 'INR', plan: { id: plan.id, label: plan.label, credits: plan.credits } };
}

function signatureMatches(orderId, paymentId, signature, secret) {
  if (![orderId, paymentId, signature, secret].every(value => typeof value === 'string' && value.length > 0)) return false;
  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function verifyPayment({ deviceId, orderId, paymentId, signature }, { env = process.env, fetchImpl = global.fetch } = {}) {
  assertConfigured(env);
  const device = assertDeviceId(deviceId);
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
    throw new PaymentError(400, 'INVALID_PAYMENT', 'The payment confirmation could not be read.');
  }
  const rawOrder = await redisCommand(['GET', orderKey(orderId)], { env, fetchImpl });
  let order;
  try { order = JSON.parse(rawOrder); } catch { throw new PaymentError(400, 'PAYMENT_EXPIRED', 'This payment session has expired. Start payment again.'); }
  if (order?.deviceId !== device || !Number.isSafeInteger(order?.credits) || order.credits < 1 || order.credits > 10 || !signatureMatches(orderId, paymentId, signature, env.RAZORPAY_KEY_SECRET.trim())) {
    throw new PaymentError(400, 'PAYMENT_NOT_VERIFIED', 'The payment could not be verified. No try-on credits were added.');
  }
  // Claiming and crediting occur in one Redis script, so a successful payment
  // cannot be replayed to add credits a second time.
  const remaining = await redisCommand(['EVAL', "if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return redis.call('INCRBY', KEYS[2], ARGV[2]) end return redis.call('GET', KEYS[2]) or '0'", 2, claimKey(orderId), creditKey(device), ORDER_TTL_SECONDS, order.credits], { env, fetchImpl });
  return { creditsRemaining: Math.max(0, Number(remaining) || 0) };
}

async function consumeTryOnCredit(deviceId, options = {}) {
  const device = assertDeviceId(deviceId);
  assertConfigured(options.env || process.env);
  const remaining = await redisCommand(['EVAL', "local credits = tonumber(redis.call('GET', KEYS[1]) or '0'); if credits <= 0 then return -1 end; return redis.call('DECR', KEYS[1])", 1, creditKey(device)], options);
  if (Number(remaining) < 0) throw new PaymentError(402, 'CREDITS_REQUIRED', 'Purchase a try-on pack before generating a preview.');
  return Number(remaining);
}

module.exports = { PLANS, PaymentError, getPaymentConfig, assertDeviceId, getCredits, createOrder, verifyPayment, consumeTryOnCredit };
