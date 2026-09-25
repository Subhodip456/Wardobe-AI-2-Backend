const { createHash } = require('node:crypto');
const { GoogleAuth } = require('google-auth-library');
const { getPaymentStore } = require('./mongoPaymentStore');
const { PaymentError, assertDeviceId } = require('./paymentService');

const PLANS = Object.freeze([
  { id: 'starter', productId: 'wardrobe_preview_starter', label: 'Starter', credits: 1 },
  { id: 'standard', productId: 'wardrobe_preview_standard', label: 'Standard', credits: 3 },
  { id: 'premium', productId: 'wardrobe_preview_premium', label: 'Premium', credits: 10 },
]);
const LIVE_MODE = 'google-play-live';
const TEST_MODE = 'google-play-test';
const CONSUMED = 'CONSUMPTION_STATE_CONSUMED';
const UNCONSUMED = 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED';
let authCache;

function credentials(env) {
  const value = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '{}');
  if (value.type !== 'service_account' || typeof value.client_email !== 'string' ||
      !value.client_email.endsWith('.iam.gserviceaccount.com') || typeof value.private_key !== 'string' ||
      !value.private_key.includes('BEGIN PRIVATE KEY')) throw new Error('Invalid service account');
  // Do not accept token endpoints or external credential providers from configuration.
  return { type: 'service_account', client_email: value.client_email, private_key: value.private_key };
}

function getPaymentConfig(env = process.env) {
  let available = false;
  try {
    credentials(env);
    available = Boolean(env.MONGODB_URI?.trim() && /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(env.GOOGLE_PLAY_PACKAGE_NAME || ''));
  } catch { /* Configuration errors never expose credentials. */ }
  return { available, provider: 'google-play', plans: PLANS,
    ...(available ? {} : { code: 'PAYMENTS_NOT_CONFIGURED', message: 'Google Play purchases are not configured yet.' }) };
}

function assertConfigured(env) {
  if (!getPaymentConfig(env).available) throw new PaymentError(503, 'PAYMENTS_NOT_CONFIGURED', 'Google Play purchases are not configured yet.');
}

function accountId(deviceId, env = process.env) {
  return createHash('sha256').update(`${env.GOOGLE_PLAY_PACKAGE_NAME}:${assertDeviceId(deviceId)}`).digest('hex');
}

async function withStore(options, operation) {
  try { return await operation(options.store || await getPaymentStore(options.env || process.env)); }
  catch (error) {
    if (error instanceof PaymentError) throw error;
    throw new PaymentError(503, 'CREDITS_UNAVAILABLE', 'Your preview balance is temporarily unavailable. Retry purchase recovery; do not buy again.');
  }
}

async function getAccessToken(env) {
  const key = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!authCache || authCache.key !== key) authCache = { key, auth: new GoogleAuth({
    credentials: credentials(env), scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  }) };
  const token = await authCache.auth.getAccessToken();
  if (!token) throw new Error('No access token');
  return token;
}

async function getCredits(deviceId, options = {}) {
  const device = assertDeviceId(deviceId);
  assertConfigured(options.env || process.env);
  return withStore(options, async store => {
    // Preserve previously verified Razorpay LIVE packs during the transition.
    // Legacy test packs remain excluded and old purchase endpoints are retired.
    const balances = await Promise.all([store.getCredits(device, LIVE_MODE), store.getCredits(device, 'live')]);
    return balances.reduce((sum, value) => sum + value, 0);
  });
}

async function consumeTryOnCredit(deviceId, options = {}) {
  const device = assertDeviceId(deviceId);
  assertConfigured(options.env || process.env);
  // License-tester purchases NEVER fund a real, billable Fal generation.
  const consumed = await withStore(options, async store =>
    await store.consumeCredit(device, LIVE_MODE) || await store.consumeCredit(device, 'live'));
  if (!consumed) throw new PaymentError(402, 'CREDITS_REQUIRED', 'Purchase a preview pack before generating. Google Play test purchases do not fund real AI previews.');
  return getCredits(device, options);
}

async function verifyPurchase({ deviceId, productId, purchaseToken }, options = {}) {
  const env = options.env || process.env;
  assertConfigured(env);
  const device = assertDeviceId(deviceId);
  const plan = PLANS.find(value => value.productId === productId);
  if (!plan || typeof purchaseToken !== 'string' || purchaseToken.length < 8 || purchaseToken.length > 4096 || /\s/.test(purchaseToken)) {
    throw new PaymentError(400, 'INVALID_PAYMENT', 'Invalid Google Play purchase.');
  }
  const store = await withStore(options, value => value);
  const storeOptions = { ...options, store };
  const id = `play:${createHash('sha256').update(`${env.GOOGLE_PLAY_PACKAGE_NAME}:${purchaseToken}`).digest('hex')}`;
  const existing = await withStore(storeOptions, value => value.getOrder(id));
  if (existing && (existing.deviceId !== device || existing.productId !== productId)) {
    throw new PaymentError(403, 'PURCHASE_OWNER_MISMATCH', 'This purchase belongs to another app installation. Contact support.');
  }
  const fetchImpl = options.fetchImpl || global.fetch;
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases`;
  let accessToken;
  let purchase;
  try {
    accessToken = await (options.getAccessToken || getAccessToken)(env);
    const response = await fetchImpl(`${base}/productsv2/tokens/${encodeURIComponent(purchaseToken)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Provider verification failed');
    purchase = await response.json();
  } catch {
    throw new PaymentError(503, 'PAYMENT_UNAVAILABLE', 'Google Play verification is unavailable. Use Recover purchases later; do not purchase again.');
  }
  if (purchase?.obfuscatedExternalAccountId !== accountId(device, env)) {
    throw new PaymentError(403, 'PURCHASE_OWNER_MISMATCH', 'This purchase is not linked to this app installation.');
  }
  const state = purchase.purchaseStateContext?.purchaseState;
  if (state === 'PENDING') throw new PaymentError(409, 'PAYMENT_PENDING', 'Google Play is still processing your payment. Credits will be added after it completes.');
  const line = purchase.productLineItem?.[0];
  const offer = line?.productOfferDetails;
  if (state !== 'PURCHASED' || purchase.productLineItem?.length !== 1 || line?.productId !== productId ||
      offer?.quantity !== 1 || offer.refundableQuantity !== 1 || offer.rentOfferDetails || offer.preorderOfferDetails ||
      ![CONSUMED, UNCONSUMED].includes(offer.consumptionState)) {
    throw new PaymentError(400, 'PAYMENT_NOT_VERIFIED', 'The purchase is cancelled, refunded, or does not match this preview pack.');
  }
  const testPurchase = purchase.testPurchaseContext != null;
  const mode = testPurchase ? TEST_MODE : LIVE_MODE;
  if (existing && existing.billingMode !== mode) throw new PaymentError(400, 'PAYMENT_NOT_VERIFIED', 'Purchase mode mismatch.');
  if (!existing && offer.consumptionState === CONSUMED) {
    throw new PaymentError(409, 'PURCHASE_ALREADY_CONSUMED', 'This purchase has already been fulfilled. Contact support if your balance is missing.');
  }
  // Atomic insert-once ledger; retries and concurrent callbacks never refill it.
  await withStore(storeOptions, value => value.grantPlayPurchase(id, {
    deviceId: device, productId, planId: plan.id, credits: plan.credits,
    billingMode: mode, provider: 'google-play', providerOrderId: purchase.orderId || null,
  }));
  if (offer.consumptionState !== CONSUMED) {
    try {
      const response = await fetchImpl(`${base}/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Consumption not confirmed');
    } catch {
      // Keep the durable ledger and client pending token. A retry re-verifies
      // Google's state and completes consumption without granting credits twice.
      throw new PaymentError(503, 'PURCHASE_FINALIZATION_PENDING', 'Your pack was recorded but Google Play confirmation is pending. Tap Recover purchases; do not buy again.');
    }
  }
  return { creditsRemaining: await getCredits(device, storeOptions), testPurchase,
    message: testPurchase ? 'Test purchase verified. No real AI credits were added and no Fal credits will be spent.' : 'Your preview credits are ready.' };
}

module.exports = { PLANS, LIVE_MODE, TEST_MODE, getPaymentConfig, getCredits, consumeTryOnCredit, verifyPurchase, accountId };
