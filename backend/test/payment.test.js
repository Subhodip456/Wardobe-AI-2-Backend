const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const { createMongoPaymentStore } = require('../services/mongoPaymentStore');
const { PLANS, getPaymentConfig, createOrder, getCredits, verifyPayment, consumeTryOnCredit, PaymentError } = require('../services/paymentService');

const env = { RAZORPAY_KEY_ID: 'rzp_test_public_key', RAZORPAY_KEY_SECRET: 'test-only-payment-secret', MONGODB_URI: 'mongodb://unused-injected-store', MONGODB_DB_NAME: 'payment_tests' };
const deviceId = '4e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';
const otherDevice = '5e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';
describe('MongoDB integration (opt in with RUN_MONGODB_INTEGRATION=1)', { skip: process.env.RUN_MONGODB_INTEGRATION !== '1' }, () => {
let server;
let client;
let sequence = 0;
before(async () => {
  // Real, isolated, temporary MongoDB. Never connects to a developer's .env DB
  // and never calls Razorpay or Fal. The first run may download mongod.
  server = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  client = await new MongoClient(server.getUri()).connect();
});
after(async () => {
  await client?.close();
  await server?.stop();
});

function fixture() {
  const collection = client.db('wardrobe_tests').collection(`orders_${++sequence}`);
  const store = createMongoPaymentStore(collection);
  let orderNumber = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders');
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ id: `order_test_${++orderNumber}`, amount: body.amount, currency: body.currency }) };
  };
  const options = { env, store, fetchImpl };
  const paymentFor = (orderId) => ({ deviceId, orderId, paymentId: `pay_${orderId}`, signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|pay_${orderId}`).digest('hex') });
  return { collection, store, options, paymentFor };
}

test('configuration requires MongoDB and retains all three prices', () => {
  assert.equal(getPaymentConfig({ ...env, MONGODB_URI: '' }).available, false);
  assert.equal(getPaymentConfig(env).available, true);
  assert.deepEqual(Object.values(PLANS).map(p => [p.amount, p.credits]), [[25000, 1], [50000, 3], [100000, 10]]);
});

test('concurrent verification credits each pack once; exhausted orders cannot be refilled', async () => {
  const { options, paymentFor } = fixture();
  const order = await createOrder({ deviceId, planId: 'standard' }, options);
  assert.equal(order.amount, 50000);
  assert.equal(await getCredits(deviceId, options), 0);
  const payment = paymentFor(order.orderId);
  await Promise.all(Array.from({ length: 12 }, () => verifyPayment(payment, options)));
  assert.equal(await getCredits(deviceId, options), 3);
  assert.equal(await consumeTryOnCredit(deviceId, options), 2);
  await verifyPayment(payment, options);
  assert.equal(await getCredits(deviceId, options), 2);
  await consumeTryOnCredit(deviceId, options);
  await consumeTryOnCredit(deviceId, options);
  await verifyPayment(payment, options);
  assert.equal(await getCredits(deviceId, options), 0);
});

test('concurrent generation requests cannot overspend paid packs, including across purchases', async () => {
  const { options, paymentFor, collection } = fixture();
  for (const planId of ['starter', 'standard', 'premium']) {
    const order = await createOrder({ deviceId, planId }, options);
    await verifyPayment(paymentFor(order.orderId), options);
  }
  assert.equal(await getCredits(deviceId, options), 14);
  const outcomes = await Promise.allSettled(Array.from({ length: 30 }, () => consumeTryOnCredit(deviceId, options)));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 14);
  for (const outcome of outcomes.filter(o => o.status === 'rejected')) assert.equal(outcome.reason.code, 'CREDITS_REQUIRED');
  assert.equal(await collection.countDocuments({ remaining: { $lt: 0 } }), 0);
  assert.equal(await getCredits(deviceId, options), 0);
});

test('forged, missing and another device\'s payments grant no credits', async () => {
  const { options, paymentFor } = fixture();
  const order = await createOrder({ deviceId, planId: 'premium' }, options);
  const payment = paymentFor(order.orderId);
  for (const changed of [{ signature: '0'.repeat(64) }, { signature: 'é'.repeat(64) }, { deviceId: otherDevice }, { orderId: 'order_missing' }]) {
    await assert.rejects(verifyPayment({ ...payment, ...changed }, options), e => e instanceof PaymentError && e.code === 'PAYMENT_NOT_VERIFIED');
  }
  assert.equal(await getCredits(deviceId, options), 0);
  await assert.rejects(consumeTryOnCredit(deviceId, options), e => e.status === 402);
  await verifyPayment(payment, options);
  assert.equal(await getCredits(otherDevice, options), 0);
  await assert.rejects(consumeTryOnCredit(otherDevice, options), e => e.status === 402);
});

test('database errors are sanitized and fail closed', async () => {
  const store = {
    getCredits: async () => { throw new Error('private database connection details'); },
    consumeCredit: async () => { throw new Error('private database connection details'); },
    createOrder: async () => { throw new Error('private database connection details'); },
  };
  const options = { ...fixture().options, store };
  const safeError = e => e.status === 503 && e.code === 'CREDITS_UNAVAILABLE' && !e.message.includes('private database');
  await assert.rejects(getCredits(deviceId, options), safeError);
  await assert.rejects(consumeTryOnCredit(deviceId, options), safeError);
  await assert.rejects(createOrder({ deviceId, planId: 'starter' }, options), safeError);
});

test('orders and balances persist across store and client instances', async () => {
  const { options, paymentFor, collection } = fixture();
  const order = await createOrder({ deviceId, planId: 'premium' }, options);
  await verifyPayment(paymentFor(order.orderId), options);
  await consumeTryOnCredit(deviceId, options);
  const secondClient = await new MongoClient(server.getUri()).connect();
  try {
    const store = createMongoPaymentStore(secondClient.db('wardrobe_tests').collection(collection.collectionName));
    assert.equal(await getCredits(deviceId, { env, store }), 9);
    await verifyPayment(paymentFor(order.orderId), { env, store });
    assert.equal(await getCredits(deviceId, { env, store }), 9);
  } finally { await secondClient.close(); }
});
});
