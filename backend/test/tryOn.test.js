const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

// Even a regression that ignores injected fetch must never contact a provider.
// Only local HTTP servers created below are allowed to receive test requests.
const networkFetch = global.fetch;
const allowedOrigins = new Set();
global.fetch = async (resource, options) => {
  const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
  assert.equal(url.hostname, '127.0.0.1', 'Tests must never contact an external host');
  assert.equal(allowedOrigins.has(url.origin), true, 'Tests may only contact their own local servers');
  return networkFetch(resource, { ...options, redirect: 'error' });
};

const express = require('express');
const { createTryOnRouter } = require('../routes/tryOn');
const { getTryOnConfig, generateTryOn, validAccessToken } = require('../services/tryOnService');

// Synthetic transport fixtures: no photos, credentials, or live API calls.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString('base64');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMhoAAAAASUVORK5CYII=';
const image = `data:image/jpeg;base64,${jpeg}`;
const accessCode = 'test-only-private-access-code-32-characters';
const providerKey = 'test-only-not-a-real-gemini-api-key';
const model = 'gemini-3.1-flash-image';
const env = { GEMINI_API_KEY: providerKey, TRY_ON_ACCESS_TOKEN: accessCode };
const input = { personImage: image, garmentImage: image, category: 'outerwear', consent: true, consentProvider: 'gemini' };
const imagePart = (data = jpeg, mimeType = 'image/jpeg', extra = {}) => ({ inlineData: { mimeType, data }, ...extra });
const providerPayload = (parts = [imagePart()], extra = {}) => ({ candidates: [{ content: { parts }, finishReason: 'STOP', ...extra }] });
const providerSuccess = (parts) => new Response(JSON.stringify(providerPayload(parts)), { status: 200 });

async function serverFor(t, options = {}) {
  const app = express();
  app.use('/api/try-on', createTryOnRouter({ env, fetchImpl: async () => providerSuccess(), ...options }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  allowedOrigins.add(origin);
  t.after(() => new Promise((resolve) => {
    allowedOrigins.delete(origin);
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `${origin}/api/try-on`;
  return {
    url,
    post: (body = input, extra = {}) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}` },
      body: JSON.stringify(body),
      ...extra,
    }),
  };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(providerKey), false);
  assert.equal(serialized.includes(accessCode), false);
  assert.equal(serialized.includes('private provider response'), false);
}

test('creating try-on routes never logs the environment or credentials', (t) => {
  let logged = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, () => { logged++; });
  }
  createTryOnRouter({ env, fetchImpl: async () => providerSuccess() });
  assert.equal(logged, 0, 'Do not log provider credentials, access codes or environment variables');
});

test('configuration requires Gemini credentials and an independent private access code', () => {
  assert.equal(getTryOnConfig({}).code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ OPENAI_API_KEY: 'test-only-old-provider-key', TRY_ON_ACCESS_TOKEN: accessCode }).code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ GEMINI_API_KEY: 'test-only-key' }).code, 'ACCESS_NOT_CONFIGURED');
  for (const token of [
    'short', 'a'.repeat(23), `${accessCode} `, 'has spaces in otherwise long code',
    `${accessCode}é`, `${accessCode}\u0000`, `${accessCode}\t`, 'a'.repeat(513),
    providerKey, 'sk-test-only-access-code-value', 'AIza-test-only-access-code-value',
  ]) {
    assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: token }).available, false);
  }
  for (const token of ['a'.repeat(24), 'a'.repeat(512), accessCode]) {
    assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: token }).available, true);
  }
  assert.equal(getTryOnConfig(env).available, true);
  assert.equal(getTryOnConfig(env).model, model);
  assert.equal(getTryOnConfig({ ...env, GEMINI_IMAGE_MODEL: model }).available, true);
  for (const unsupported of ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gpt-image-2', `${model}/other`, `${model}?key=hidden`]) {
    assert.equal(getTryOnConfig({ ...env, GEMINI_IMAGE_MODEL: unsupported }).code, 'MODEL_NOT_CONFIGURED');
  }
});

test('access comparison rejects absent, wrong, malformed and oversized bearer tokens', () => {
  assert.equal(validAccessToken(undefined, accessCode), false);
  assert.equal(validAccessToken(`Basic ${accessCode}`, accessCode), false);
  assert.equal(validAccessToken('Bearer wrong', accessCode), false);
  assert.equal(validAccessToken(`Bearer ${providerKey}`, accessCode), false);
  assert.equal(validAccessToken(`Bearer ${'x'.repeat(513)}`, accessCode), false);
  assert.equal(validAccessToken(`Bearer ${accessCode}`, accessCode), true);
});

test('configuration advertises Gemini and the locked model without exposing secrets or calling provider', async (t) => {
  const api = await serverFor(t, { fetchImpl: async () => { throw new Error('must not call provider'); } });
  const response = await fetch(`${api.url}/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { available: true, provider: 'gemini', requiresAccessCode: true, model });
  assertNoSecrets(body);
});

test('configuration remains unavailable until both independent credentials are valid', async (t) => {
  for (const unavailableEnv of [{}, { GEMINI_API_KEY: providerKey }, { TRY_ON_ACCESS_TOKEN: accessCode }, { ...env, TRY_ON_ACCESS_TOKEN: providerKey }]) {
    const api = await serverFor(t, { env: unavailableEnv, fetchImpl: async () => { throw new Error('must not call provider'); } });
    const response = await fetch(`${api.url}/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, false);
    assert.equal(body.provider, 'gemini');
    assert.equal(body.requiresAccessCode, true);
    assert.equal(body.model, model);
    assertNoSecrets(body);
  }
});

test('unconfigured endpoint returns an actionable 503 before parsing', async (t) => {
  const api = await serverFor(t, { env: {} });
  const response = await api.post(input, { body: '{bad-json' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROVIDER_NOT_CONFIGURED');
});

test('authorization rejects absent and wrong codes before parsing uploaded images', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  for (const authorization of [undefined, 'Bearer wrong-code', `Bearer ${providerKey}`]) {
    const headers = { 'Content-Type': 'application/json' };
    if (authorization) headers.Authorization = authorization;
    const response = await api.post(input, { headers, body: '{not-json' });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'ACCESS_CODE_REQUIRED');
    assertNoSecrets(body);
  }
  assert.equal(calls, 0);
});

test('rejects malformed JSON and unsupported content types', async (t) => {
  const api = await serverFor(t);
  const malformed = await api.post(input, { body: '{not-json' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'INVALID_JSON');
  const unsupported = await api.post(input, { headers: { Authorization: `Bearer ${accessCode}`, 'Content-Type': 'text/plain' } });
  assert.equal(unsupported.status, 415);
});

test('rejects oversized JSON without invoking provider', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  const response = await api.post({ ...input, personImage: 'a'.repeat(3700000) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'UPLOAD_TOO_LARGE');
  assert.equal(calls, 0);
});

test('explicit consent and a supported garment category are required', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  for (const consent of [false, undefined, 'true']) {
    const response = await api.post({ ...input, consent });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'CONSENT_REQUIRED');
  }
  const unsupported = await api.post({ ...input, category: 'shoes' });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).code, 'UNSUPPORTED_CATEGORY');
  assert.equal(calls, 0);
});

test('missing, stale and malformed provider consent cannot send photos to Gemini', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  for (const consentProvider of [undefined, 'openai', 'Gemini', '', null, true]) {
    const response = await api.post({ ...input, consentProvider });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'CONSENT_PROVIDER_MISMATCH');
  }
  assert.equal(calls, 0);
});

test('rejects URLs, non-JPEG data, invalid base64 and either decoded image above 1 MiB', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0);
  oversized.set([0xff, 0xd8, 0xff], 0);
  oversized.set([0xff, 0xd9], oversized.length - 2);
  const invalid = [
    'https://example.com/person.jpg', 'http://169.254.169.254/latest/meta-data/',
    `data:image/png;base64,${png}`, 'data:image/jpeg;base64,not base64!', 'data:image/jpeg;base64,aGVsbG8=',
    `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
    `data:image/jpeg;base64,${oversized.toString('base64')}`, image + '\n',
  ];
  for (const field of ['personImage', 'garmentImage']) {
    for (const value of invalid) {
      const response = await api.post({ ...input, [field]: value });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_IMAGE');
    }
  }
  assert.equal(calls, 0);
});

test('successful endpoint sends both images to Gemini and returns a labelled JPEG preview', async (t) => {
  const calls = [];
  const api = await serverFor(t, { fetchImpl: async (...args) => { calls.push(args); return providerSuccess(); } });
  const response = await api.post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.imageDataUrl, image);
  assert.match(result.disclaimer, /not a fit or size guarantee/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assertNoSecrets(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  const options = calls[0][1];
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  const headers = new Headers(options.headers);
  assert.equal(headers.get('x-goog-api-key'), providerKey);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.has('authorization'), false);
  assert.equal(new URL(calls[0][0]).search, '');
  const upstream = JSON.parse(options.body);
  assert.equal(upstream.contents.length, 1);
  assert.equal(upstream.contents[0].role, 'user');
  assert.equal(upstream.contents[0].parts.length, 3);
  assert.match(upstream.contents[0].parts[0].text, /outerwear/);
  assert.match(upstream.contents[0].parts[0].text, /identity/);
  assert.deepEqual(upstream.contents[0].parts.slice(1), [imagePart(), imagePart()]);
  assert.deepEqual(upstream.generationConfig, {
    candidateCount: 1, responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '2:3', imageSize: '1K' },
  });
  assert.equal(options.body.includes(providerKey), false);
  assert.equal(options.body.includes(accessCode), false);
  assert.equal(options.signal instanceof AbortSignal, true);
});

test('the exact model override is supported and every supported category reaches the prompt', async () => {
  for (const category of ['top', 'bottom', 'dress', 'outerwear']) {
    await generateTryOn({ ...input, category }, { env: { ...env, GEMINI_IMAGE_MODEL: model }, fetchImpl: async (url, options) => {
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
      assert.equal(JSON.parse(options.body).contents[0].parts[0].text.includes(category), true);
      return providerSuccess();
    } });
  }
});

test('PNG output retains its MIME type and intermediate thought images are never returned', async () => {
  const result = await generateTryOn(input, { env, fetchImpl: async () => providerSuccess([
    imagePart(jpeg, 'image/jpeg', { thought: true }),
    { text: 'Private reasoning is not a preview.', thought: true },
    imagePart(png, 'image/png'),
  ]) });
  assert.equal(result.imageDataUrl, `data:image/png;base64,${png}`);
  assert.equal(JSON.stringify(result).includes('Private reasoning'), false);
  assertNoSecrets(result);
});

for (const [status, providerStatus, details, expectedStatus, expectedCode] of [
  [401, 'UNAUTHENTICATED', undefined, 503, 'PROVIDER_ACCESS_ERROR'],
  [403, 'PERMISSION_DENIED', undefined, 503, 'PROVIDER_ACCESS_ERROR'],
  [400, 'INVALID_ARGUMENT', [{ reason: 'API_KEY_INVALID' }], 503, 'PROVIDER_ACCESS_ERROR'],
  [400, 'FAILED_PRECONDITION', undefined, 503, 'PROVIDER_ACCESS_ERROR'],
  [404, 'NOT_FOUND', undefined, 503, 'MODEL_NOT_CONFIGURED'],
  [429, 'RESOURCE_EXHAUSTED', undefined, 429, 'PROVIDER_BUSY'],
  [400, 'INVALID_ARGUMENT', undefined, 422, 'GENERATION_REJECTED'],
  [500, 'INTERNAL', undefined, 502, 'PROVIDER_UNAVAILABLE'],
  [503, 'UNAVAILABLE', undefined, 502, 'PROVIDER_UNAVAILABLE'],
]) {
  test(`provider ${status}/${providerStatus}${details ? '/API_KEY_INVALID' : ''} is sanitized without retries`, async (t) => {
    let calls = 0;
    const api = await serverFor(t, { fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: {
        code: status, status: providerStatus, details, message: `private provider response ${providerKey} ${accessCode}`,
      } }), { status });
    } });
    const response = await api.post();
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    assert.equal(result.code, expectedCode);
    assertNoSecrets(result);
    if (status === 429) {
      assert.match(JSON.stringify(result), /quota/i);
      assert.match(JSON.stringify(result), /billing/i);
    }
    assert.equal(calls, 1);
  });
}

test('prompt safety blocks return IMAGE_REJECTED without exposing provider details', async (t) => {
  const api = await serverFor(t, { fetchImpl: async () => new Response(JSON.stringify({
    promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: `private provider response ${providerKey}` },
  })) });
  const response = await api.post();
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, 'IMAGE_REJECTED');
  assertNoSecrets(body);
});

for (const finishReason of ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'IMAGE_RECITATION', 'BLOCKLIST', 'IMAGE_PROHIBITED_CONTENT', 'SPII']) {
  test(`candidate ${finishReason} cannot expose a blocked image`, async (t) => {
    const api = await serverFor(t, { fetchImpl: async () => new Response(JSON.stringify(providerPayload([imagePart()], { finishReason }))) });
    const response = await api.post();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'IMAGE_REJECTED');
  });
}

test('candidate safety ratings block otherwise valid images', async () => {
  await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => new Response(JSON.stringify(providerPayload([imagePart()], {
    safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', blocked: true }],
  }))) }), { status: 422, code: 'IMAGE_REJECTED' });
});

test('text refusals, incomplete generation and thought-only images are rejected', async () => {
  for (const payload of [
    providerPayload([{ text: `private provider response ${providerKey}` }]),
    providerPayload([imagePart()], { finishReason: 'MAX_TOKENS' }),
    providerPayload([imagePart(jpeg, 'image/jpeg', { thought: true })]),
    providerPayload([]),
  ]) {
    await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => new Response(JSON.stringify(payload)) }), (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'GENERATION_REJECTED');
      assertNoSecrets({ message: error.message });
      return true;
    });
  }
});

test('malformed JSON, missing candidates and invalid output cannot become previews', async () => {
  const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  const oversizedDimensions = Buffer.from(png, 'base64');
  oversizedDimensions.writeUInt32BE(4097, 16);
  const invalidHeader = Buffer.from(png, 'base64');
  invalidHeader.writeUInt32BE(12, 8);
  const missingTrailer = Buffer.from(png, 'base64').subarray(0, -12).toString('base64');
  for (const [body, code] of [
    ['not-json', 'INVALID_PROVIDER_RESPONSE'],
    [JSON.stringify({ candidates: [] }), 'INVALID_PREVIEW'],
    [JSON.stringify({ candidates: [{ content: {} }] }), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart('aGVsbG8=')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(truncatedJpeg)])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(truncatedPng, 'image/png')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(oversizedDimensions.toString('base64'), 'image/png')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(invalidHeader.toString('base64'), 'image/png')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(missingTrailer, 'image/png')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(jpeg, 'image/png')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(png, 'image/jpeg')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(jpeg, 'image/webp')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(jpeg + '\n')])), 'INVALID_PREVIEW'],
    [JSON.stringify(providerPayload([imagePart(), imagePart()])), 'INVALID_PREVIEW'],
    [JSON.stringify({ candidates: [{ content: { parts: [] } }, { content: { parts: [imagePart()] } }] }), 'INVALID_PREVIEW'],
  ]) {
    await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => new Response(body) }), { status: 502, code });
  }
});

test('provider response and decoded output limits reject excessive data', async () => {
  const oversized = Buffer.alloc(2900004, 0);
  oversized.set([0xff, 0xd8, 0xff], 0);
  oversized.set([0xff, 0xd9], oversized.length - 2);
  for (const body of [JSON.stringify(providerPayload([imagePart(oversized.toString('base64'))])), ' '.repeat(4100001)]) {
    await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => new Response(body) }), { status: 502, code: 'PREVIEW_TOO_LARGE' });
  }
});

test('network failures do not expose provider credentials', async () => {
  await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => { throw new Error(`${providerKey} ${accessCode}`); } }), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assertNoSecrets({ message: error.message });
    return true;
  });
});

test('generation timeout aborts upstream and returns an actionable 504', async (t) => {
  let wasAborted = false;
  let calls = 0;
  const api = await serverFor(t, { timeoutMs: 25, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('abort')); }, { once: true });
  }) });
  const response = await api.post();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'GENERATION_TIMEOUT');
  assert.equal(wasAborted, true);
  assert.equal(calls, 1);
});

test('caller cancellation aborts upstream without retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = generateTryOn(input, { env, signal: controller.signal, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    queueMicrotask(() => controller.abort());
  }) });
  await assert.rejects(result, { code: 'REQUEST_CANCELLED' });
  assert.equal(calls, 1);
});

test('already cancelled request never calls the image provider', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(generateTryOn(input, { env, signal: controller.signal, fetchImpl: async () => { calls++; return providerSuccess(); } }), { code: 'REQUEST_CANCELLED' });
  assert.equal(calls, 0);
});
