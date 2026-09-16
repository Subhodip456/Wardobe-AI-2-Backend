const test = require('node:test');
const assert = require('node:assert/strict');
const { getTryOnConfig, validAccessToken, validateTryOnInput, generateTryOn, TryOnError, FAL_TRY_ON_ENDPOINT } = require('../services/tryOnService');

const accessCode = 'private-test-access-code-12345';
const providerKey = 'test-only-not-a-real-fal-key';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString('base64');
const image = `data:image/jpeg;base64,${jpeg}`;
const outputPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const env = { FAL_KEY: providerKey, TRY_ON_ACCESS_TOKEN: accessCode };
const input = { personImage: image, garmentImage: image, category: 'outerwear', consent: true, consentProvider: 'fal' };

test('configuration requires Fal credentials and a separate access code', () => {
  assert.equal(getTryOnConfig({}).code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(getTryOnConfig({ FAL_KEY: providerKey }).code, 'ACCESS_NOT_CONFIGURED');
  assert.deepEqual(getTryOnConfig(env), { available: true, provider: 'fal', requiresAccessCode: true, model: FAL_TRY_ON_ENDPOINT });
  assert.equal(getTryOnConfig({ ...env, TRY_ON_ACCESS_TOKEN: providerKey }).code, 'ACCESS_NOT_CONFIGURED');
});

test('access-code comparison does not accept the provider key', () => {
  assert.equal(validAccessToken(`Bearer ${accessCode}`, accessCode), true);
  assert.equal(validAccessToken(`Bearer ${providerKey}`, accessCode), false);
});

test('input requires fresh Fal consent and valid JPEGs', () => {
  assert.equal(validateTryOnInput(input).category, 'outerwear');
  assert.throws(() => validateTryOnInput({ ...input, consentProvider: 'huggingface' }), /Fal/);
  assert.throws(() => validateTryOnInput({ ...input, personImage: 'not-an-image' }), /JPEG/);
});

test('generation sends separate person and garment images to Fal and safely returns its image', async () => {
  let endpoint;
  let options;
  const falClient = { subscribe: async (id, request) => { endpoint = id; options = request; return { data: { images: [{ url: 'https://v3b.fal.media/files/test-preview.png' }] } }; } };
  const pngBytes = Uint8Array.from(Buffer.from(outputPng.split(',')[1], 'base64'));
  const fetchImpl = async (url) => {
    assert.equal(String(url), 'https://v3b.fal.media/files/test-preview.png');
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => pngBytes.buffer };
  };
  const result = await generateTryOn(input, { env, falClient, fetchImpl });
  assert.equal(endpoint, FAL_TRY_ON_ENDPOINT);
  assert.equal(options.input.person_image_url, image);
  assert.equal(options.input.clothing_image_url, image);
  assert.equal(options.input.preserve_pose, true);
  assert.match(result.imageDataUrl, /^data:image\/png;base64,/);
});

test('Fal errors are sanitized and not leaked to the client', async () => {
  await assert.rejects(
    generateTryOn(input, { env, falClient: { subscribe: async () => { const error = new Error('private provider details'); error.status = 429; throw error; } } }),
    (error) => error instanceof TryOnError && error.code === 'PROVIDER_BUSY' && !error.message.includes('private provider details'),
  );
});
