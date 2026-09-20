const test = require('node:test');
const assert = require('node:assert/strict');
const { getTryOnConfig, validateTryOnInput, generateTryOn, TryOnError, FAL_TRY_ON_ENDPOINT } = require('../services/tryOnService');

const providerKey = 'test-only-not-a-real-fal-key';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString('base64');
const image = `data:image/jpeg;base64,${jpeg}`;
const outputPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const env = { FAL_KEY: providerKey };
const input = { personImage: image, garmentImage: image, category: 'outerwear' };

test('configuration requires Fal credentials', () => {
  assert.equal(getTryOnConfig({}).code, 'PROVIDER_NOT_CONFIGURED');
  assert.deepEqual(getTryOnConfig(env), { available: true, provider: 'fal', requiresPurchase: true, model: FAL_TRY_ON_ENDPOINT });
});

test('input requires supported categories and valid JPEGs', () => {
  assert.equal(validateTryOnInput(input).category, 'outerwear');
  assert.throws(() => validateTryOnInput({ ...input, category: 'shoes' }), /top, bottom, dress, or outerwear/);
  assert.throws(() => validateTryOnInput({ ...input, personImage: 'not-an-image' }), /JPEG/);
});

test('generation sends separate person and garment images to Fal and returns its trusted media URL', async () => {
  let endpoint;
  let options;
  const falClient = { subscribe: async (id, request) => { endpoint = id; options = request; return { data: { images: [{ url: 'https://v3b.fal.media/files/test-preview.png' }] } }; } };
  const result = await generateTryOn(input, { env, falClient });
  assert.equal(endpoint, FAL_TRY_ON_ENDPOINT);
  assert.equal(options.input.person_image_url, image);
  assert.equal(options.input.clothing_image_url, image);
  assert.equal(options.input.preserve_pose, true);
  assert.equal(result.imageUrl, 'https://v3b.fal.media/files/test-preview.png');
});

test('Fal errors are sanitized and not leaked to the client', async () => {
  await assert.rejects(
    generateTryOn(input, { env, falClient: { subscribe: async () => { const error = new Error('private provider details'); error.status = 429; throw error; } } }),
    (error) => error instanceof TryOnError && error.code === 'PROVIDER_BUSY' && !error.message.includes('private provider details'),
  );
});
