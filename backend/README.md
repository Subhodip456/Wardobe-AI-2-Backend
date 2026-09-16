# Wardrobe AI backend

Try-on uses **Google Gemini Nano Banana 2**, model `gemini-3.1-flash-image`, with the person photo and garment photo in one request. This replaces OpenAI image editing; there is no OpenAI fallback. Claude still handles the existing tagging and outfit-recommendation endpoints.

## Configure the existing Vercel deployment

1. Keep the Vercel project's **Root Directory set to `backend`**. The frontend is intentionally excluded from this GitHub repository. Leave Build Command and Output Directory unset; use `npm ci` for Install Command. `vercel.json` routes requests to `api/index.js`, which exports the Express app.
2. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/api-keys) for a project with **billing enabled and Nano Banana 2 access**. In Vercel's Production environment, set `GEMINI_API_KEY` to that key. Never put it in React Native, an `EXPO_PUBLIC_*` variable, test fixtures, logs or Git.
3. Optionally set `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image`. That exact Nano Banana 2 model is the default and the only permitted model. Nano Banana, Nano Banana Pro and Nano Banana 2 Lite are different models; this integration does not silently substitute them.
4. Set `TRY_ON_ACCESS_TOKEN` to an independent, random private-beta code of 24–512 printable ASCII characters, without spaces. A randomly generated 32-byte hex value is appropriate. Share it privately with trusted testers, who enter it in the app. **Do not use a Gemini or other provider API key as the access code.** Replace previously exposed codes and revoke any exposed API keys.
5. `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL` are no longer read by try-on. They can be removed from this Vercel project if nothing else uses them. `ANTHROPIC_API_KEY` remains separate for Claude tagging/recommendations.
6. Keep the **300-second** function duration in `vercel.json`; confirm your Vercel plan/Fluid compute configuration supports it. The backend stops waiting at 240 seconds; the app at 270 seconds. Redeploy after saving the environment variables. No Node.js version or dependency change is required for this migration.
7. Reload/update the React Native app too. Consent now explicitly names Google Gemini; older app versions are rejected before photos are forwarded to Google.
8. Open [try-on readiness](https://wardobe-ai-2-backend.vercel.app/api/try-on/config). Expected response: `{"available":true,"provider":"gemini","requiresAccessCode":true,"model":"gemini-3.1-flash-image"}`. This only checks local configuration, **not key validity, billing, remaining quota or image quality**. It does not invoke the provider.
9. With your own photos and permission, test one preview in the updated app. Google may charge for generation. This code has local/mock tests, not a claim that your live project is configured or generation has been tested against it.

Nano Banana 2's Gemini API is **paid**, even if a consumer Gemini website offers free image generation. Check [Google's current pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-image) and your project's limits before enabling access. Outputs use portrait `2:3`, `1K` resolution and one candidate. There are no automatic generation retries and no fallback to another provider/model.

## Local setup and tests

In `backend`, run `npm ci`, copy `.env.example` to an ignored `.env`, configure the values privately, then run `npm start`. Importing `server.js` or `api/index.js` does not start a listening server, so the same app works in Vercel.

Run `npm test` for backend tests. They use synthetic images, dummy credentials, loopback HTTP and injected/mock provider responses—never production endpoints or paid image generation. Do not replace fixtures with real API keys or point the test helper at Vercel. From the app root, run `npm run typecheck` and `node --test scripts/check-try-on.cjs` for client checks. Node.js remains unchanged.

## HTTP contract

- `GET /health`: existing health check.
- `GET /api/try-on/config`: safe readiness containing `available`, `provider: "gemini"`, `requiresAccessCode: true`, `model` and, when unavailable, a safe `code`/`message`. No credentials or provider calls.
- `POST /api/try-on`: `Authorization: Bearer <private access code>` and JSON:

  ```json
  {
    "personImage": "data:image/jpeg;base64,...",
    "garmentImage": "data:image/jpeg;base64,...",
    "category": "outerwear",
    "consent": true,
    "consentProvider": "gemini"
  }
  ```

- Success: `{"imageDataUrl":"data:image/png;base64,...","disclaimer":"..."}`. JPEG outputs are also supported; MIME must match the returned image.
- Failure: `{"code":"...","message":"..."}` with a suitable HTTP status. No raw Google messages, request payloads or keys are returned/logged.

Authentication runs before parsing uploads. Missing/incorrect codes return 401. Missing consent or `consentProvider` for Google returns 400 without invoking Gemini. Supported categories are tops, bottoms, dresses and outerwear. Each input must be a JPEG no larger than 1 MiB, and JSON requests are capped at 3.5 MiB. The app resizes/compresses full photos without cropping before upload.

The backend calls Google's documented `generateContent` REST endpoint, with the key in the `x-goog-api-key` header, two inline JPEG inputs, no tools and default safety settings. It does not upload to Google's Files API or fetch remote image URLs. It ignores intermediate thought images and only returns a final validated PNG/JPEG. Provider responses are bounded to 4.1 MB and the decoded result to 2.9 MB to keep returned JSON below Vercel's response limit. A result that exceeds the cap is rejected without an automatic paid retry. Image framing/base64 are checked; this is not a complete local image decoder.

### Troubleshooting

- `PROVIDER_NOT_CONFIGURED`: add `GEMINI_API_KEY` in Vercel and redeploy.
- `ACCESS_NOT_CONFIGURED`: set an independent private beta code and redeploy.
- `MODEL_NOT_CONFIGURED`: verify the exact `GEMINI_IMAGE_MODEL` and project model access.
- `PROVIDER_ACCESS_ERROR`: check the Gemini key, API restrictions, project billing and model access.
- `PROVIDER_BUSY` (429): Google reported a request or quota limit. Check Google AI Studio's billing and model limits. A temporary rate limit can reset; absent billing or exhausted quota is not fixed by repeatedly tapping Generate.
- `CONSENT_PROVIDER_MISMATCH`: update/reload the mobile app and give fresh consent naming Google Gemini.
- `IMAGE_REJECTED` / `GENERATION_REJECTED`: Google blocked the request or returned no finished image. No filter is bypassed and no other provider is tried.
- `PREVIEW_TOO_LARGE`, `INVALID_PREVIEW` or a timeout: no usable result was delivered. Generation may already have incurred a charge; do not assume retrying is free.

## Privacy and release scope

The result is an AI styling illustration, **not an exact fit, size or tailoring prediction**. The prompt asks to preserve identity, body shape and garment details, but accuracy is not guaranteed. Google adds SynthID provenance; this backend does not remove it.

The app sends photos only after explicit Google consent and Generate. This backend holds photos/results in memory and does not save them to files or a database. The app does not save try-on results to the closet. Google processes the photos under its own terms; do not promise zero provider retention. Do not enable request-body/header logging. Review [Google's image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation), [API reference](https://ai.google.dev/api/generate-content), [Gemini API terms/data use](https://ai.google.dev/gemini-api/terms) and [error guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).

The shared access code is only for a **private beta**. Before a public Play Store launch, replace it with per-user authentication, durable per-user and global quotas, rate limiting and atomic credit reservations. The older Claude routes also need authentication/rate limiting. Apply provider billing controls now.

Client/server cancellation is best effort: Google may finish and bill after a network failure or timeout. A production release should use durable jobs, protected image storage and recovery of completed results. These controls are not added by this provider migration.
