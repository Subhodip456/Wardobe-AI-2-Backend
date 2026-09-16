const { createHash, timingSafeEqual } = require('node:crypto');

const INPUT_IMAGE_BYTES = 1024 * 1024;
const OUTPUT_IMAGE_BYTES = 2900000;
const PROVIDER_RESPONSE_BYTES = 4100000;
const DEFAULT_TIMEOUT_MS = 240000;
// Hugging Face's documented image-to-image model/provider pair; override in Vercel if needed.
const DEFAULT_IMAGE_MODEL = 'black-forest-labs/FLUX.2-klein-9B';
const PROVIDER = 'huggingface';
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
  const model = env.HF_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  const base = { available: false, provider: PROVIDER, requiresAccessCode: true, model };
  if (!env.HF_TOKEN?.trim()) {
    return { ...base, code: 'PROVIDER_NOT_CONFIGURED', message: 'Add the server-only HF_TOKEN with Inference Providers permission to the backend environment, then redeploy.' };
  }
  if (!env.TRY_ON_ACCESS_TOKEN || env.TRY_ON_ACCESS_TOKEN.length < 24 || env.TRY_ON_ACCESS_TOKEN.length > 512 ||
      /[^\x21-\x7e]/.test(env.TRY_ON_ACCESS_TOKEN) ||
      env.TRY_ON_ACCESS_TOKEN === env.HF_TOKEN.trim() || /^(?:sk-|AIza|hf_)/.test(env.TRY_ON_ACCESS_TOKEN)) {
    return { ...base, code: 'ACCESS_NOT_CONFIGURED', message: 'The backend owner must configure a separate private try-on access code of at least 24 characters and redeploy.' };
  }
  return { ...base, available: true };
}

function validAccessToken(authorization, expected) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !expected) return false;
  const supplied = authorization.slice(7);
  if (!supplied || supplied.length > 512) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

function decodeBase64(base64, maximumBytes) {
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length % 4 !== 0 ||
      base64.length > Math.ceil(maximumBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length <= maximumBytes && bytes.toString('base64') === base64 ? bytes : null;
}

function validJpegBase64(base64, maximumBytes) {
  const bytes = decodeBase64(base64, maximumBytes);
  return !!bytes && bytes.length >= 5 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function validPngBase64(base64, maximumBytes) {
  const bytes = decodeBase64(base64, maximumBytes);
  // Validate the declared format and framing, not just a MIME label. The provider decodes inputs;
  // the mobile image renderer decodes outputs. No image is written to disk here.
  return !!bytes && bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.readUInt32BE(16) <= 4096 && bytes.readUInt32BE(20) <= 4096 &&
    bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
}

function validateTryOnInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TryOnError(400, 'INVALID_REQUEST', 'Choose a person photo and a garment before generating.');
  }
  if (body.consent !== true) {
    throw new TryOnError(400, 'CONSENT_REQUIRED', 'Confirm permission to send your photo to the backend and Hugging Face for this preview.');
  }
  // Never silently switch the image recipient named by the consent screen.
  if (body.consentProvider !== PROVIDER) {
    throw new TryOnError(400, 'CONSENT_PROVIDER_MISMATCH', 'Update the app and agree to send your photo to Hugging Face before generating.');
  }
  if (!CATEGORIES.has(body.category)) {
    throw new TryOnError(400, 'UNSUPPORTED_CATEGORY', 'Choose a top, bottom, dress, or outerwear item for your preview.');
  }
  for (const field of ['personImage', 'garmentImage']) {
    const image = body[field];
    if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,') ||
        !validJpegBase64(image.slice('data:image/jpeg;base64,'.length), INPUT_IMAGE_BYTES)) {
      throw new TryOnError(400, 'INVALID_IMAGE', 'Both photos must be JPEG images smaller than 1 MB. Choose the photos again and retry.');
    }
  }
  return { personImage: body.personImage, garmentImage: body.garmentImage, category: body.category };
}

function mapProviderError(status, error) {
  if (status === 401 || status === 403) return new TryOnError(503, 'PROVIDER_ACCESS_ERROR', 'The backend owner must check HF_TOKEN permissions and Hugging Face Inference Providers access.');
  if (status === 404) return new TryOnError(503, 'MODEL_NOT_CONFIGURED', 'Hugging Face could not find the configured image model or provider route. Check HF_IMAGE_MODEL.');
  if (status === 429) return new TryOnError(429, 'PROVIDER_BUSY', 'Hugging Face or its inference provider is busy or out of credits. Check your HF usage and wait before retrying.');
  if (status === 400 || status === 422) {
    return new TryOnError(422, 'GENERATION_REJECTED', 'The image service could not create this preview. Try another clear photo or ask the owner to check image-model configuration.');
  }
  return new TryOnError(502, 'PROVIDER_UNAVAILABLE', 'The image service is temporarily unavailable. Try again later.');
}

function readGeneratedImage(data) {
  const blocked = data?.promptFeedback?.blockReason;
  const candidates = data?.candidates;
  const candidate = Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
  const safetyReasons = new Set(['SAFETY', 'IMAGE_SAFETY', 'RECITATION', 'IMAGE_RECITATION',
    'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'SPII']);
  if ((blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED') || safetyReasons.has(candidate?.finishReason) ||
      candidate?.safetyRatings?.some?.((rating) => rating?.blocked === true)) {
    throw new TryOnError(422, 'IMAGE_REJECTED', 'Hugging Face could not use this photo. Choose a clear, fully clothed photo and retry.');
  }
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new TryOnError(422, 'GENERATION_REJECTED', 'The image provider did not finish an image for this photo. Try another clear photo; no automatic retry was made.');
  }
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new TryOnError(502, 'INVALID_PREVIEW', 'Hugging Face returned no usable image. Please try again later.');
  }
  // Thought images are intermediate reasoning artifacts, not the finished try-on.
  const images = parts.filter((part) => part && !part.thought && part.inlineData);
  if (images.length === 0) {
    throw new TryOnError(422, 'GENERATION_REJECTED', 'Hugging Face did not return a finished image. Try another clear photo; no automatic retry was made.');
  }
  if (images.length !== 1) {
    throw new TryOnError(502, 'INVALID_PREVIEW', 'The image provider returned an unexpected preview format. Please try again later.');
  }
  const { mimeType, data: base64 } = images[0].inlineData;
  if (typeof base64 === 'string' && base64.length > Math.ceil(OUTPUT_IMAGE_BYTES / 3) * 4) {
    throw new TryOnError(502, 'PREVIEW_TOO_LARGE', 'The generated preview was too large to deliver. No automatic retry was made.');
  }
  const valid = mimeType === 'image/jpeg' ? validJpegBase64(base64, OUTPUT_IMAGE_BYTES)
    : mimeType === 'image/png' && validPngBase64(base64, OUTPUT_IMAGE_BYTES);
  if (!valid) {
    throw new TryOnError(502, 'INVALID_PREVIEW', 'The image provider returned an invalid preview image. Please try again later.');
  }
  return `data:${mimeType};base64,${base64}`;
}

async function readGeneratedHuggingFaceImage(response) {
  if (!response.ok) {
    let error;
    try { error = await response.json(); } catch { /* provider may return plain text */ }
    throw mapProviderError(response.status, error);
  }
  const contentType = response.headers?.get?.('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) throw new TryOnError(502, 'INVALID_PREVIEW', 'Hugging Face returned no usable image. Please try again later.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > OUTPUT_IMAGE_BYTES) throw new TryOnError(502, 'PREVIEW_TOO_LARGE', 'The generated preview was too large to deliver.');
  const mimeType = contentType.split(';', 1)[0].toLowerCase();
  const valid = mimeType === 'image/jpeg' ? validJpegBase64(buffer.toString('base64'), OUTPUT_IMAGE_BYTES)
    : mimeType === 'image/png' && validPngBase64(buffer.toString('base64'), OUTPUT_IMAGE_BYTES);
  if (!valid) throw new TryOnError(502, 'INVALID_PREVIEW', 'Hugging Face returned an invalid preview image. Please try again later.');
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new TryOnError(502, 'INVALID_PROVIDER_RESPONSE', 'The image service returned no preview. Please try again.');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TryOnError(502, 'PREVIEW_TOO_LARGE', 'The generated preview was too large to deliver. Try a simpler photo.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TryOnError(502, 'INVALID_PROVIDER_RESPONSE', 'The image service returned an unreadable response. Please try again later.');
  }
}

async function generateTryOn(body, { env = process.env, fetchImpl = global.fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const config = getTryOnConfig(env);
  if (!config.available) throw new TryOnError(503, config.code, config.message);
  const { personImage, garmentImage, category } = validateTryOnInput(body);
  if (signal?.aborted) throw new TryOnError(499, 'REQUEST_CANCELLED', 'The preview request was cancelled.');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    const model = env.HF_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
    const provider = env.HF_PROVIDER?.trim() || 'fal-ai';
    const endpoint = `https://router.huggingface.co/${encodeURIComponent(provider)}/models/${model}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.HF_TOKEN.trim()}`, 'Content-Type': 'application/json', Accept: 'image/*' },
      redirect: 'error', // Never forward credentials or personal photos to a redirect destination.
      signal: controller.signal,
      body: JSON.stringify({
        inputs: personImage.slice('data:image/jpeg;base64,'.length),
        parameters: {
          prompt: `Create one photorealistic virtual clothing try-on preview for a fully clothed person wearing a ${category}. Preserve identity, face, skin tone, body shape, pose, hair, camera perspective, and background. Keep the garment area natural and do not add text, collages, measurements, or claims of exact fit.`,
          negative_prompt: 'text, watermark, collage, distorted face, extra limbs, nudity',
          target_size: { width: 768, height: 1152 },
        },
      }),
    });
    return { imageDataUrl: await readGeneratedHuggingFaceImage(response), disclaimer: DISCLAIMER };
  } catch (error) {
    if (timedOut) throw new TryOnError(504, 'GENERATION_TIMEOUT', 'Image generation took too long. A request may still have been charged; wait before trying again.');
    if (signal?.aborted) throw new TryOnError(499, 'REQUEST_CANCELLED', 'The preview request was cancelled.');
    if (error instanceof TryOnError) throw error;
    throw new TryOnError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach the image service. Try again later.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { getTryOnConfig, validAccessToken, validateTryOnInput, generateTryOn, TryOnError };
