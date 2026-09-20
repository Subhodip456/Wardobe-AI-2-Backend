const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { securityMiddleware } = require('../routes/security');
const { createSecurityStore } = require('../services/securityStore');
const { createMongoPaymentStore } = require('../services/mongoPaymentStore');
const { getPaymentConfig, verifyPayment, getCredits, consumeTryOnCredit } = require('../services/paymentService');

const subject = '4e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';
const env = { RAZORPAY_KEY_ID: 'rzp_live_testfixture', RAZORPAY_KEY_SECRET: 'fixture-only-secret', MONGODB_URI: 'unused-injected-store' };
function fixture() {
  let activations = 0;
  let fetches = 0;
  const record = { deviceId: subject, billingMode: 'live', credits: 3, amount: 50000 };
  const orderId = 'order_fixture';
  const paymentId = 'pay_fixture';
  const args = { deviceId: subject, orderId, paymentId,
    signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex') };
  const payment = { id: paymentId, order_id: orderId, amount: 50000, currency: 'INR', status: 'captured', captured: true, amount_refunded: 0, refund_status: null };
  const store = { getOrder: async () => record, activateOrder: async () => { activations++; }, getCredits: async () => 3 };
  const options = { env, store, fetchImpl: async () => { fetches++; return { ok: true, json: async () => payment }; } };
  return { args, options, payment, record, counts: () => ({ activations, fetches }) };
}

test('payment grants require matching captured, unrefunded provider payment', async () => {
  const good = fixture();
  assert.deepEqual(await verifyPayment(good.args, good.options), { creditsRemaining: 3 });
  assert.equal(good.counts().activations, 1);
  for (const change of [{ status: 'authorized' }, { captured: false }, { order_id: 'order_other' },
    { amount: 25000 }, { currency: 'USD' }, { amount_refunded: 1 }, { refund_status: 'partial' }, { id: 'pay_other' }]) {
    const f = fixture();
    Object.assign(f.payment, change);
    await assert.rejects(verifyPayment(f.args, f.options), error => error.code === 'PAYMENT_NOT_VERIFIED');
    assert.equal(f.counts().activations, 0);
  }
});

test('forged signatures, wrong identities and test-mode orders cannot grant credits', async () => {
  for (const change of [{ signature: '0'.repeat(64) }, { signature: 'é'.repeat(64) },
    { deviceId: '5e44c4e4-8df0-4a28-8bc5-f6f3fe87f825' }]) {
    const f = fixture();
    await assert.rejects(verifyPayment({ ...f.args, ...change }, f.options), error => error.code === 'PAYMENT_NOT_VERIFIED');
    assert.deepEqual(f.counts(), { activations: 0, fetches: 0 });
  }
  const f = fixture();
  f.record.billingMode = 'test';
  await assert.rejects(verifyPayment(f.args, f.options), error => error.code === 'PAYMENT_NOT_VERIFIED');
  assert.equal(f.counts().activations, 0);
});

test('provider/database failures fail closed without leaking errors', async () => {
  const f = fixture();
  f.options.fetchImpl = async () => { throw new Error('private provider details'); };
  await assert.rejects(verifyPayment(f.args, f.options), error => error.code === 'PAYMENT_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(f.counts().activations, 0);
  const store = { getCredits: async () => { throw new Error('private database details'); } };
  await assert.rejects(getCredits(subject, { env, store }), error => error.code === 'CREDITS_UNAVAILABLE' && !error.message.includes('private'));
  await assert.rejects(consumeTryOnCredit(subject, { env, store: { consumeCredit: async () => false } }), error => error.status === 402);
});

test('test payment keys are explicit opt-in and blocked on production', () => {
  const testEnv = { ...env, RAZORPAY_KEY_ID: 'rzp_test_fixture' };
  assert.equal(getPaymentConfig(testEnv).available, false);
  assert.equal(getPaymentConfig({ ...testEnv, ALLOW_TEST_PAYMENTS: 'true' }).available, true);
  assert.equal(getPaymentConfig({ ...testEnv, ALLOW_TEST_PAYMENTS: 'true', VERCEL_ENV: 'production' }).available, false);
  assert.equal(getPaymentConfig({ ...testEnv, ALLOW_TEST_PAYMENTS: 'true', NODE_ENV: 'production' }).available, false);
});

async function middlewareRequest({ path = '/payments/credits', method = 'GET', authorization, security, headers = {} } = {}) {
  let nextCalled = false;
  const req = { path, method, get: name => name === 'Authorization' ? authorization : headers[name] };
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await securityMiddleware({ getStore: async () => {
    if (!security) throw new Error('private db failure');
    return { security };
  } })(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('a UUID header alone cannot access any protected API', async () => {
  for (const path of ['/payments/credits', '/payments/orders', '/payments/verify', '/try-on', '/wardrobe/tag', '/outfit/generate']) {
    const r = await middlewareRequest({ path, method: 'POST', headers: { 'X-Wardrobe-Device-ID': subject } });
    assert.equal(r.res.statusCode, 401);
    assert.equal(r.nextCalled, false);
  }
});

test('authenticated subject comes only from server-side session and limits fail closed', async () => {
  const authorization = `Bearer ${'a'.repeat(64)}`;
  const security = { authenticate: async () => ({ subject }), allow: async () => true };
  const r = await middlewareRequest({ authorization, security, headers: { 'X-Wardrobe-Device-ID': 'attacker' } });
  assert.equal(r.req.auth.subject, subject);
  assert.equal(r.nextCalled, true);
  for (const authenticate of [async () => null, async () => { throw new Error('private'); }]) {
    const denied = await middlewareRequest({ authorization, security: { ...security, authenticate } });
    assert.equal(denied.nextCalled, false);
    assert.ok([401, 503].includes(denied.res.statusCode));
  }
  const limited = await middlewareRequest({ authorization, security: { ...security, allow: async () => false } });
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.nextCalled, false);
});

test('AI limits apply to case-insensitive and trailing-slash routes', async () => {
  const keys = [];
  const r = await middlewareRequest({ path: '/OuTfIt/GeNeRaTe/', method: 'POST', authorization: `Bearer ${'a'.repeat(64)}`,
    security: { authenticate: async () => ({ subject }), allow: async key => { keys.push(key); return key !== 'ai:global'; } } });
  assert.equal(r.res.statusCode, 429);
  assert.equal(r.nextCalled, false);
  assert.ok(keys.includes('ai:global'));
});

test('guest registration limits run before session creation', async () => {
  let created = 0;
  const r = await middlewareRequest({ path: '/session', method: 'POST', security: {
    allow: async () => false, createSession: async () => { created++; },
  } });
  assert.equal(r.res.statusCode, 429);
  assert.equal(created, 0);
});

test('session store persists only token hashes and explicitly checks expiry/revocation', async () => {
  let saved, filter;
  const store = createSecurityStore({ collection: () => ({
    insertOne: async value => { saved = value; }, findOne: async value => { filter = value; return null; },
  }) });
  const session = await store.createSession();
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.notEqual(saved._id, session.token);
  assert.equal(JSON.stringify(saved).includes(session.token), false);
  await store.authenticate(session.token);
  assert.equal(filter._id, saved._id);
  assert.ok(filter.expiresAt.$gt instanceof Date);
  assert.deepEqual(filter.revoked, { $ne: true });
});

test('credit store filters modes and keeps conditional atomic decrement', async () => {
  let filter;
  const store = createMongoPaymentStore({ findOneAndUpdate: async (query, update) => {
    filter = query;
    assert.deepEqual(update, { $inc: { remaining: -1 } });
    return null;
  } });
  assert.equal(await store.consumeCredit(subject, 'live'), false);
  assert.equal(filter.billingMode, 'live');
  assert.deepEqual(filter.remaining, { $gt: 0 });
  assert.equal(filter.state, 'paid');
});
