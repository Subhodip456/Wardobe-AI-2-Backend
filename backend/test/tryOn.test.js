const test = require('node:test');
const assert = require('node:assert/strict');
const { getTryOnConfig, validAccessToken, validateTryOnInput, generateTryOn, TryOnError } = require('../services/tryOnService');

const accessCode = 'private-test-access-code-12345';
const providerToken = 'hf_test-only-not-a-real-token';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString('base64');
const image = `data:image/jpeg;base64,${jpeg}`;
const env = { HF_TOKEN: providerToken, HF_PROVIDER: 'fal-ai', TRY_ON_ACCESS_TOKEN: accessCode };
const input = { personImage: image, garmentImage: image, category: 'outerwear', consent: true, consentProvider: 'huggingface' };

function imageResponse() {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes };
}

test('configuration requires Hugging Face credentials and a separate access code', () => {
  assert.equal(getTryOnConfig({}).code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ HF_TOKEN: providerToken }).code, 'ACCESS_NOT_CONFIGURED');
  assert.equal(getTryOnConfig(env).available, true);
  assert.equal(getTryOnConfig(env).provider, 'huggingface');
  assert.equal(getTryOnConfig(env).model, 'black-forest-labs/FLUX.1-Kontext-dev');
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: providerToken }).code, 'ACCESS_NOT_CONFIGURED');
});

test('access token comparison is constant-time and provider tokens are not accepted', () => {
  assert.equal(validAccessToken(`Bearer ${accessCode}`, accessCode), true);
  assert.equal(validAccessToken(`Bearer ${providerToken}`, accessCode), false);
  assert.equal(validAccessToken('Bearer wrong', accessCode), false);
});

test('input requires fresh Hugging Face consent and valid JPEGs', () => {
  assert.deepEqual(validateTryOnInput(input).category, 'outerwear');
  assert.throws(() => validateTryOnInput({ ...input, consentProvider: 'gemini' }), /Hugging Face/);
  assert.throws(() => validateTryOnInput({ ...input, personImage: 'not-an-image' }), /JPEG/);
});

test('generation routes through Hugging Face without logging credentials or photos', async () => {
  let request;
  let logged = false;
  const originalLog = console.log;
  console.log = () => { logged = true; };
  try {
    const result = await generateTryOn(input, {
      env,
      fetchImpl: async (url, options) => { request = { url, options }; return imageResponse(); },
    });
    assert.match(request.url, /router\.huggingface\.co\/fal-ai\/models\/black-forest-labs\/FLUX\.1-Kontext-dev/);
    assert.equal(request.options.headers.Authorization, `Bearer ${providerToken}`);
    assert.equal(JSON.parse(request.options.body).inputs, jpeg);
    assert.match(result.imageDataUrl, /^data:image\/png;base64,/);
    assert.equal(logged, false);
  } finally { console.log = originalLog; }
});

test('provider errors are mapped without leaking provider response bodies', async () => {
  await assert.rejects(
    generateTryOn(input, { env, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'private provider details' }) }) }),
    (error) => error instanceof TryOnError && error.code === 'PROVIDER_BUSY' && !error.message.includes('private provider details'),
  );
});
