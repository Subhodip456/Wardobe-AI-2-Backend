const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PLANS, LIVE_MODE, TEST_MODE, accountId, getPaymentConfig, verifyPurchase, getCredits, consumeTryOnCredit } = require('../services/googlePlayService');
const { createMongoPaymentStore } = require('../services/mongoPaymentStore');

const deviceId = '4e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';
const other = '5e44c4e4-8df0-4a28-8bc5-f6f3fe87f825';
const env = { MONGODB_URI: 'unused-test-store', GOOGLE_PLAY_PACKAGE_NAME: 'com.yourcompany.wardrobeai',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'test@test.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----fixture-only' }) };
function fixture(overrides = {}) {
  const rows = new Map();
  // Exercise the actual Mongo ledger methods using an in-memory collection.
  const collection = {
    async updateOne(filter, update, options) {
      if (!rows.has(filter._id) && options?.upsert) rows.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
    },
    async findOne(filter) { return rows.get(filter._id); },
    aggregate(pipeline) { return { async toArray() {
      const match = pipeline[0].$match;
      return [{ credits: [...rows.values()].filter(row => row.deviceId === match.deviceId && row.billingMode === match.billingMode && row.state === 'paid').reduce((sum, row) => sum + row.remaining, 0) }];
    } }; },
    async findOneAndUpdate(filter) {
      const row = [...rows.values()].find(row => row.deviceId === filter.deviceId && row.billingMode === filter.billingMode && row.state === 'paid' && row.remaining > 0);
      if (row) row.remaining--;
      return row || null;
    },
  };
  const state = {
    purchase: { obfuscatedExternalAccountId: accountId(deviceId, env), orderId: 'GPA.fixture',
      purchaseStateContext: { purchaseState: 'PURCHASED' }, productLineItem: [{ productId: PLANS[1].productId,
        productOfferDetails: { quantity: 1, refundableQuantity: 1, consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED' } }],
      ...overrides }, consumeFails: false, calls: [],
  };
  const store = createMongoPaymentStore(collection);
  const options = { env, store, getAccessToken: async () => 'fake-oauth', fetchImpl: async (url, init) => {
    state.calls.push({ url, method: init.method });
    assert.equal(init.headers.Authorization, 'Bearer fake-oauth');
    assert.equal(init.redirect, 'error');
    assert.ok(url.startsWith(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${env.GOOGLE_PLAY_PACKAGE_NAME}/purchases/`));
    if (url.endsWith(':consume')) {
      if (state.consumeFails) return { ok: false };
      state.purchase.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
      return { ok: true };
    }
    return { ok: true, json: async () => structuredClone(state.purchase) };
  } };
  const input = { deviceId, productId: PLANS[1].productId, purchaseToken: 'fixture-token-never-real' };
  return { rows, state, store, options, input };
}

test('Play config is independent of Razorpay and exposes only the pack catalog', () => {
  assert.equal(getPaymentConfig(env).available, true);
  assert.equal(getPaymentConfig({ ...env, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: 'broken' }).available, false);
  assert.equal(getPaymentConfig({ ...env, GOOGLE_PLAY_PACKAGE_NAME: '' }).available, false);
  assert.equal(getPaymentConfig({ ...env, MONGODB_URI: '' }).available, false);
  assert.deepEqual(PLANS.map(p => p.credits), [1, 3, 10]);
  assert.ok(!JSON.stringify(getPaymentConfig(env)).includes('PRIVATE KEY'));
});

test('verified Play pack is granted once under concurrent callbacks and replay', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, () => verifyPurchase(f.input, f.options)));
  assert.equal(f.rows.size, 1);
  assert.equal(await getCredits(deviceId, f.options), 3);
  await consumeTryOnCredit(deviceId, f.options);
  await verifyPurchase(f.input, f.options);
  assert.equal(await getCredits(deviceId, f.options), 2);
  assert.equal([...f.rows.values()][0].billingMode, LIVE_MODE);
  assert.ok(!JSON.stringify([...f.rows.values()]).includes(f.input.purchaseToken));
});

test('only Google-verified product selects 1, 3 or 10 credits', async () => {
  for (const plan of PLANS) {
    const f = fixture();
    f.input.productId = plan.productId;
    f.state.purchase.productLineItem[0].productId = plan.productId;
    await verifyPurchase({ ...f.input, credits: 999, amount: 1 }, f.options);
    assert.equal(await getCredits(deviceId, f.options), plan.credits);
  }
});

test('pending, cancelled, wrong product, refunded and multi-quantity purchases grant nothing', async () => {
  for (const change of [
    p => { p.purchaseStateContext.purchaseState = 'PENDING'; },
    p => { p.purchaseStateContext.purchaseState = 'CANCELLED'; },
    p => { p.productLineItem[0].productId = PLANS[2].productId; },
    p => { p.productLineItem[0].productOfferDetails.refundableQuantity = 0; },
    p => { p.productLineItem[0].productOfferDetails.quantity = 2; },
    p => { p.productLineItem[0].productOfferDetails.consumptionState = 'unknown'; },
    p => { p.productLineItem[0].productOfferDetails.rentOfferDetails = {}; },
  ]) {
    const f = fixture(); change(f.state.purchase);
    await assert.rejects(verifyPurchase(f.input, f.options));
    assert.equal(f.rows.size, 0);
    assert.equal(f.state.calls.length, 1);
  }
});

test('purchase must belong to authenticated subject, not client-selected account', async () => {
  const f = fixture();
  await assert.rejects(verifyPurchase({ ...f.input, deviceId: other }, f.options), e => e.code === 'PURCHASE_OWNER_MISMATCH');
  assert.equal(f.rows.size, 0);
  await verifyPurchase(f.input, f.options);
  await assert.rejects(verifyPurchase({ ...f.input, deviceId: other }, f.options), e => e.code === 'PURCHASE_OWNER_MISMATCH');
});

test('test purchases can complete checkout but never fund Fal, even in production', async () => {
  const f = fixture({ testPurchaseContext: { fopType: 'TEST' } });
  f.options.env = { ...env, VERCEL_ENV: 'production', ALLOW_TEST_PAYMENTS: 'true' };
  const result = await verifyPurchase(f.input, f.options);
  assert.equal(result.testPurchase, true);
  assert.equal(result.creditsRemaining, 0);
  assert.equal([...f.rows.values()][0].billingMode, TEST_MODE);
  await assert.rejects(consumeTryOnCredit(deviceId, f.options), e => e.code === 'CREDITS_REQUIRED');
});

test('failed consumption can recover without refilling an existing pack', async () => {
  const f = fixture(); f.state.consumeFails = true;
  await assert.rejects(verifyPurchase(f.input, f.options), e => e.code === 'PURCHASE_FINALIZATION_PENDING');
  assert.equal(f.rows.size, 1);
  f.state.consumeFails = false;
  await verifyPurchase(f.input, f.options);
  assert.equal(await getCredits(deviceId, f.options), 3);
  await verifyPurchase(f.input, f.options);
  assert.equal(await getCredits(deviceId, f.options), 3);
});

test('unknown consumed purchase cannot be used to mint credits', async () => {
  const f = fixture(); f.state.purchase.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
  await assert.rejects(verifyPurchase(f.input, f.options), e => e.code === 'PURCHASE_ALREADY_CONSUMED');
  assert.equal(f.rows.size, 0);
});

test('provider and database failures fail closed without leaking secrets', async () => {
  const f = fixture();
  await assert.rejects(verifyPurchase(f.input, { ...f.options, fetchImpl: async () => { throw new Error('PRIVATE'); } }), e => e.code === 'PAYMENT_UNAVAILABLE' && !e.message.includes('PRIVATE'));
  await assert.rejects(verifyPurchase(f.input, { ...f.options, store: { getOrder: async () => { throw new Error('PRIVATE'); } } }), e => e.code === 'CREDITS_UNAVAILABLE');
  assert.equal(f.rows.size, 0);
});

test('credit spending is atomic, preserves legacy live packs and excludes test orders', async () => {
  const f = fixture(); await verifyPurchase(f.input, f.options);
  f.rows.set('legacy', { deviceId, billingMode: 'live', state: 'paid', remaining: 1 });
  f.rows.set('legacy-test', { deviceId, billingMode: 'test', state: 'paid', remaining: 100 });
  f.rows.set('test', { deviceId, billingMode: TEST_MODE, state: 'paid', remaining: 100 });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => consumeTryOnCredit(deviceId, f.options)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(await getCredits(deviceId, f.options), 0);
});
