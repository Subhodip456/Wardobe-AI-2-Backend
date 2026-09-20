const { createFalClient, ValidationError } = require('@fal-ai/client');

const INPUT_IMAGE_BYTES = 1024 * 1024;
const OUTPUT_IMAGE_BYTES = 2900000;
const DEFAULT_TIMEOUT_MS = 240000;
const FAL_TRY_ON_ENDPOINT = 'fal-ai/image-apps-v2/virtual-try-on';
const PROVIDER = 'fal';
const CATEGORIES = new Set(['top', 'bottom', 'dress', 'outerwear']);
const DISCLAIMER = 'AI-generated styling preview, not a fit or size guarantee. Details and appearance may differ from the real garment.';

class TryOnError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getTryOnConfig(env = process.env) {
  const base = { available: false, provider: PROVIDER, requiresPurchase: true, model: FAL_TRY_ON_ENDPOINT };
  if (!env.FAL_KEY?.trim()) {
    return { ...base, code: 'PROVIDER_NOT_CONFIGURED', message: 'Add the server-only FAL_KEY to the backend environment, then redeploy.' };
  }
  return { ...base, available: true };
}

function decodeBase64(base64, maximumBytes) {
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length % 4 !== 0 ||
      base64.length > Math.ceil(maximumBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length <= maximumBytes && bytes.toString('base64') === base64 ? bytes : null;
}

function validJpegBase64(base64, maximumBytes) {
  const bytes = decodeBase64(base64, maximumBytes);
  return !!bytes && bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function validPngBase64(base64, maximumBytes) {
  const bytes = decodeBase64(base64, maximumBytes);
  return !!bytes && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(16) <= 4096 && bytes.readUInt32BE(20) <= 4096 &&
    bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
}

function validWebpBase64(base64, maximumBytes) {
  const bytes = decodeBase64(base64, maximumBytes);
  // A WebP file is a RIFF container whose format tag is WEBP. The mobile
  // client still decodes the image; this only verifies the returned file is a
  // bounded image container before it is forwarded to the app.
  return !!bytes && bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
}

function validateTryOnInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TryOnError(400, 'INVALID_REQUEST', 'Choose a person photo and a garment before generating.');
  if (!CATEGORIES.has(body.category)) throw new TryOnError(400, 'UNSUPPORTED_CATEGORY', 'Choose a top, bottom, dress, or outerwear item for your preview.');
  for (const field of ['personImage', 'garmentImage']) {
    const image = body[field];
    if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,') ||
        !validJpegBase64(image.slice('data:image/jpeg;base64,'.length), INPUT_IMAGE_BYTES)) {
      throw new TryOnError(400, 'INVALID_IMAGE', 'Both photos must be JPEG images smaller than 1 MB. Choose the photos again and retry.');
    }
  }
  return { personImage: body.personImage, garmentImage: body.garmentImage, category: body.category };
}

function mapFalError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if (status === 401 || status === 403) return new TryOnError(503, 'PROVIDER_ACCESS_ERROR', 'The backend owner must check FAL_KEY and Fal account access.');
  if (status === 404) return new TryOnError(503, 'MODEL_NOT_CONFIGURED', 'Fal could not find the virtual try-on endpoint.');
  if (status === 429) return new TryOnError(429, 'PROVIDER_BUSY', 'Fal is busy or the account has reached its spending limit. Check Fal usage and wait before retrying.');
  if (status === 400 || status === 422 || error instanceof ValidationError) return new TryOnError(422, 'GENERATION_REJECTED', 'Fal could not create this preview from these photos. Use a clear full-body photo and a clear garment-only photo, then retry.');
  return new TryOnError(502, 'PROVIDER_UNAVAILABLE', 'The image service is temporarily unavailable. Try again later.');
}

function validateGeneratedDataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned no usable preview image. Please try again later.');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned an invalid preview image. Please try again later.');
  const valid = match[1] === 'image/jpeg' ? validJpegBase64(match[2], OUTPUT_IMAGE_BYTES)
    : match[1] === 'image/png' ? validPngBase64(match[2], OUTPUT_IMAGE_BYTES)
      : validWebpBase64(match[2], OUTPUT_IMAGE_BYTES);
  if (!valid) throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned an invalid preview image. Please try again later.');
  return value;
}

function validateFalMediaUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned an invalid preview URL.'); }
  // Fal's generated media is served from its own HTTPS media hosts. Only expose
  // this allowlisted URL to the mobile app; never accept an arbitrary provider URL.
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.fal.media') || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned an unexpected preview location.');
  }
  return parsed.toString();
}

function getFalPreviewUrl(result) {
  // The Fal client returns { data: { images: [...] } }; accepting `result` as a
  // fallback keeps this stable if a future client version returns the output directly.
  const output = result?.data ?? result;
  return Array.isArray(output?.images) ? output.images[0]?.url : undefined;
}

async function generateTryOn(body, { env = process.env, fetchImpl = global.fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS, falClient } = {}) {
  const config = getTryOnConfig(env);
  if (!config.available) throw new TryOnError(503, config.code, config.message);
  const { personImage, garmentImage } = validateTryOnInput(body);
  if (signal?.aborted) throw new TryOnError(499, 'REQUEST_CANCELLED', 'The preview request was cancelled.');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    const client = falClient || createFalClient({
      credentials: env.FAL_KEY.trim(),
      fetch: (url, options) => fetchImpl(url, { ...options, signal: controller.signal }),
      retry: { maxRetries: 0 },
    });
    const result = await client.subscribe(FAL_TRY_ON_ENDPOINT, {
      input: {
        person_image_url: personImage,
        clothing_image_url: garmentImage,
        preserve_pose: true,
        aspect_ratio: { ratio: '3:4' },
      },
    });
    const imageUrl = getFalPreviewUrl(result);
    if (typeof imageUrl !== 'string') {
      throw new TryOnError(502, 'INVALID_PREVIEW', 'Fal returned no usable preview image. Please try again later.');
    }
    const previewUrl = imageUrl.startsWith('data:') ? validateGeneratedDataUrl(imageUrl) : validateFalMediaUrl(imageUrl);
    return { imageUrl: previewUrl, disclaimer: DISCLAIMER };
  } catch (error) {
    if (timedOut) throw new TryOnError(504, 'GENERATION_TIMEOUT', 'Image generation took too long. A request may still have been charged; wait before trying again.');
    if (signal?.aborted) throw new TryOnError(499, 'REQUEST_CANCELLED', 'The preview request was cancelled.');
    if (error instanceof TryOnError) throw error;
    throw mapFalError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { getTryOnConfig, validateTryOnInput, generateTryOn, TryOnError, FAL_TRY_ON_ENDPOINT };
