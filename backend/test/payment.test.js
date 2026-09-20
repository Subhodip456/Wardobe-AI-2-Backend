const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { PLANS, createOrder, getCredits, verifyPayment, consumeTryOnCredit, PaymentError } = require('../services/paymentService');

const env = {
  RAZORPAY_KEY_ID: 'rzp_test_public_key',
  RAZORPAY_KEY_SECRET: 'test-only-payment-secret',
  UPSTASH_REDIS_REST_URL: 'https://redis.example',
  UPSTASH_REDIS_REST_TOKEN: 'test-only-redis-token',
};
const deviceId = '4e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';

function response(result) { return { ok: true, json: async () => ({ result }) }; }

function paymentFetch() {
  const store = new Map();
  let orderNumber = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://api.razorpay.com/v1/orders') {
      const body = JSON.parse(init.body);
      orderNumber += 1;
      return { ok: true, json: async () => ({ id: `order_test_${orderNumber}`, amount: body.amount, currency: body.currency }) };
    }
    const command = JSON.parse(init.body);
    if (command[0] === 'GET') return response(store.get(command[1]) || null);
    if (command[0] === 'SET') { store.set(command[1], command[2]); return response('OK'); }
    if (command[0] === 'EVAL' && command[1].includes('INCRBY')) {
      const [, , , claim, credits, , increment] = command;
      if (!store.has(claim)) {
        store.set(claim, '1');
        store.set(credits, String((Number(store.get(credits) || 0)) + Number(increment)));
      }
      return response(store.get(credits) || '0');
    }
    if (command[0] === 'EVAL' && command[1].includes("redis.call('DECR'")) {
      const key = command[3];
      const amount = Number(store.get(key) || 0);
      if (amount <= 0) return response(-1);
      store.set(key, String(amount - 1));
      return response(amount - 1);
    }
    throw new Error(`Unexpected Redis command: ${command[0]}`);
  };
  return { fetchImpl, store };
}

test('paid Razorpay order grants the selected plan exactly once and credits are consumed atomically', async () => {
  const { fetchImpl } = paymentFetch();
  const order = await createOrder({ deviceId, planId: 'standard' }, { env, fetchImpl });
  assert.equal(order.amount, PLANS.standard.amount);
  assert.equal(order.plan.credits, 3);
  const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${order.orderId}|pay_test_1`).digest('hex');
  assert.deepEqual(await verifyPayment({ deviceId, orderId: order.orderId, paymentId: 'pay_test_1', signature }, { env, fetchImpl }), { creditsRemaining: 3 });
  assert.deepEqual(await verifyPayment({ deviceId, orderId: order.orderId, paymentId: 'pay_test_1', signature }, { env, fetchImpl }), { creditsRemaining: 3 });
  assert.equal(await getCredits(deviceId, { env, fetchImpl }), 3);
  assert.equal(await consumeTryOnCredit(deviceId, { env, fetchImpl }), 2);
  assert.equal(await consumeTryOnCredit(deviceId, { env, fetchImpl }), 1);
  assert.equal(await consumeTryOnCredit(deviceId, { env, fetchImpl }), 0);
  await assert.rejects(consumeTryOnCredit(deviceId, { env, fetchImpl }), (error) => error instanceof PaymentError && error.code === 'CREDITS_REQUIRED');
});
