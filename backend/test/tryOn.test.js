const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createTryOnRouter } = require('../routes/tryOn');
const { getTryOnConfig, generateTryOn, validAccessToken } = require('../services/tryOnService');

// Synthetic header fixture for transport validation only; no person's photo and no live API calls.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString('base64');
const image = `data:image/jpeg;base64,${jpeg}`;
const accessCode = 'test-only-private-access-code-32-characters';
const env = { OPENAI_API_KEY: 'test-only-not-a-real-api-key', TRY_ON_ACCESS_TOKEN: accessCode };
const input = { personImage: image, garmentImage: image, category: 'outerwear', consent: true };
const providerSuccess = () => new Response(JSON.stringify({ data: [{ b64_json: jpeg }] }), { status: 200 });

async function serverFor(t, options = {}) {
  const app = express();
  app.use('/api/try-on', createTryOnRouter({ env, fetchImpl: async () => providerSuccess(), ...options }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/try-on`;
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

test('configuration fails closed without a provider key or independent access code', () => {
  assert.equal(getTryOnConfig({}).code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ OPENAI_API_KEY: 'test' }).code, 'ACCESS_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: 'short' }).available, false);
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: `${accessCode} ` }).available, false);
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: 'has spaces in otherwise long code' }).available, false);
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: 'a'.repeat(513) }).available, false);
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: env.OPENAI_API_KEY }).available, false);
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: 'sk-do-not-enter-an-openai-provider-key-here' }).available, false);
  assert.equal(getTryOnConfig({ ...env, OPENAI_IMAGE_MODEL: 'not-an-image-model' }).code, 'MODEL_NOT_CONFIGURED');
  assert.equal(getTryOnConfig(env).available, true);
});

test('access comparison rejects absent, wrong, malformed and oversized bearer tokens', () => {
  assert.equal(validAccessToken(undefined, accessCode), false);
  assert.equal(validAccessToken(`Basic ${accessCode}`, accessCode), false);
  assert.equal(validAccessToken('Bearer wrong', accessCode), false);
  assert.equal(validAccessToken(`Bearer ${'x'.repeat(513)}`, accessCode), false);
  assert.equal(validAccessToken(`Bearer ${accessCode}`, accessCode), true);
});

test('configuration endpoint does not expose secrets or call provider', async (t) => {
  const api = await serverFor(t, { fetchImpl: async () => { throw new Error('must not call'); } });
  const response = await fetch(`${api.url}/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { available: true, provider: 'openai', requiresAccessCode: true });
  assert.equal(JSON.stringify(body).includes(env.OPENAI_API_KEY), false);
  assert.equal(JSON.stringify(body).includes(accessCode), false);
});

test('unconfigured endpoint returns an actionable 503 before parsing', async (t) => {
  const api = await serverFor(t, { env: {} });
  const response = await api.post(input, { body: '{bad-json' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROVIDER_NOT_CONFIGURED');
});

test('authorization happens before parsing uploaded images', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  const response = await api.post(input, { headers: { 'Content-Type': 'application/json' }, body: '{not-json' });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'ACCESS_CODE_REQUIRED');
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

test('consent and supported garment category are required', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  const noConsent = await api.post({ ...input, consent: false });
  assert.equal(noConsent.status, 400);
  assert.equal((await noConsent.json()).code, 'CONSENT_REQUIRED');
  const unsupported = await api.post({ ...input, category: 'shoes' });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).code, 'UNSUPPORTED_CATEGORY');
  assert.equal(calls, 0);
});

test('rejects URLs, non-JPEG data, invalid base64 and decoded images above 1 MiB', async (t) => {
  let calls = 0;
  const api = await serverFor(t, { fetchImpl: async () => { calls++; return providerSuccess(); } });
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0);
  oversized.set([0xff, 0xd8, 0xff], 0);
  oversized.set([0xff, 0xd9], oversized.length - 2);
  const invalid = [
    'https://example.com/person.jpg',
    'http://169.254.169.254/latest/meta-data/',
    `data:image/png;base64,${jpeg}`,
    'data:image/jpeg;base64,not base64!',
    'data:image/jpeg;base64,aGVsbG8=',
    `data:image/jpeg;base64,${oversized.toString('base64')}`,
    image + '\n',
  ];
  for (const personImage of invalid) {
    const response = await api.post({ ...input, personImage });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_IMAGE');
  }
  assert.equal(calls, 0);
});

test('successful endpoint passes both images to OpenAI and returns a labelled JPEG preview', async (t) => {
  const calls = [];
  const api = await serverFor(t, { fetchImpl: async (...args) => { calls.push(args); return providerSuccess(); } });
  const response = await api.post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.imageDataUrl, image);
  assert.match(result.disclaimer, /not a fit or size guarantee/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.openai.com/v1/images/edits');
  const options = calls[0][1];
  assert.equal(options.headers.Authorization, `Bearer ${env.OPENAI_API_KEY}`);
  const upstream = JSON.parse(options.body);
  assert.deepEqual(upstream.images, [{ image_url: image }, { image_url: image }]);
  assert.equal(upstream.model, 'gpt-image-2');
  assert.equal(upstream.n, 1);
  assert.equal(upstream.moderation, 'auto');
  assert.equal(upstream.output_format, 'jpeg');
  assert.equal(upstream.output_compression, 75);
  assert.match(upstream.prompt, /outerwear/);
  assert.match(upstream.prompt, /identity/);
});

test('supported model override reaches provider', async () => {
  await generateTryOn(input, { env: { ...env, OPENAI_IMAGE_MODEL: 'gpt-image-2-2026-04-21' }, fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).model, 'gpt-image-2-2026-04-21');
    return providerSuccess();
  } });
});

for (const [status, providerCode, expectedStatus, expectedCode] of [
  [401, 'invalid_api_key', 503, 'PROVIDER_ACCESS_ERROR'],
  [403, 'permission_denied', 503, 'PROVIDER_ACCESS_ERROR'],
  [429, 'insufficient_quota', 503, 'PROVIDER_QUOTA_EXCEEDED'],
  [429, 'rate_limit_exceeded', 429, 'PROVIDER_BUSY'],
  [400, 'moderation_blocked', 422, 'IMAGE_REJECTED'],
  [400, 'invalid_request', 422, 'GENERATION_REJECTED'],
  [500, 'internal_error', 502, 'PROVIDER_UNAVAILABLE'],
]) {
  test(`provider ${status}/${providerCode} is sanitized without automatic retries`, async (t) => {
    let calls = 0;
    const api = await serverFor(t, { fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: providerCode, message: `private provider response ${env.OPENAI_API_KEY}` } }), { status });
    } });
    const response = await api.post();
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    assert.equal(result.code, expectedCode);
    assert.equal(JSON.stringify(result).includes('private provider response'), false);
    assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
    assert.equal(calls, 1);
  });
}

test('malformed success, missing images and oversized provider responses are handled', async () => {
  for (const [body, code] of [
    ['not-json', 'INVALID_PROVIDER_RESPONSE'],
    [JSON.stringify({ data: [] }), 'INVALID_PREVIEW'],
    [JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), 'INVALID_PREVIEW'],
    [' '.repeat(4100001), 'PREVIEW_TOO_LARGE'],
  ]) {
    await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => new Response(body) }), { code });
  }
});

test('network failures do not expose provider credentials', async () => {
  await assert.rejects(generateTryOn(input, { env, fetchImpl: async () => { throw new Error(env.OPENAI_API_KEY); } }), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.message.includes(env.OPENAI_API_KEY), false);
    return true;
  });
});

test('generation timeout aborts upstream and returns an actionable 504', async (t) => {
  let wasAborted = false;
  const api = await serverFor(t, { timeoutMs: 25, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('abort')); }, { once: true });
  }) });
  const response = await api.post();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'GENERATION_TIMEOUT');
  assert.equal(wasAborted, true);
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
