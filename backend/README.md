# Wardrobe AI backend

The try-on endpoint now calls OpenAI image editing with the person photo and garment photo. Claude remains responsible for the existing tagging and outfit-recommendation endpoints. An Anthropic key cannot enable image generation, and a ChatGPT/Codex subscription does not provide a deployable API key.

## Configure the existing Vercel deployment

1. Set the Vercel project's **Root Directory to `backend`**, not the repository root. The frontend is intentionally excluded from this GitHub repository. Keep Build Command unset and Output Directory unset; use `npm ci` for Install Command. The checked-in `vercel.json` selects the generic Node function deployment, with `api/index.js` loading the Express app and forwarding all existing URLs to it.
2. In Vercel project environment variables, add `OPENAI_API_KEY` from your own OpenAI API project with billing and image-model access. Never add that key to React Native, an `EXPO_PUBLIC_*` variable, or source control.
3. Add `TRY_ON_ACCESS_TOKEN`: a separate randomly generated private-test access code of at least 24 characters. A 32-byte random hex string is appropriate. Give this code only to trusted testers; they enter it in the Try on screen. **Do not use your OpenAI key as the access code.**
4. Optionally set `OPENAI_IMAGE_MODEL`; default is `gpt-image-2`. The service also permits its dated snapshot and GPT Image 2.5 Sunburst/Flare aliases and September 8 snapshots. Availability depends on your OpenAI project.
5. `vercel.json` requests a **300-second** function duration to accommodate the 240-second upstream timeout plus upload/response time. Enable Fluid compute / confirm your Vercel plan supports that duration; a legacy Hobby runtime without Fluid compute cannot provide it. Redeploy after changing environment variables or function settings. No Node.js installation or runtime version change is included in this code update.
6. Open `https://wardobe-ai-2-backend.vercel.app/api/try-on/config`. It must return `"available": true`. This check does not generate images or incur an image-generation charge. Then test from the app with your own photos and the private access code. Each generation may incur an OpenAI API charge.

The code exports the Express app for serverless deployment and still supports `npm start` locally. In the backend directory, run `npm ci`, copy `.env.example` to an ignored `.env`, configure it, then `npm start`. Tests use only mocks: `npm test`. The backend lockfile is committed for reproducible installs. No Node.js upgrade is required by this change.

## HTTP contract

- `GET /health`: existing health check.
- `GET /api/try-on/config`: safe configuration readiness (no credentials, no provider call). Readiness confirms configuration exists, not that the key has valid billing/model access.
- `POST /api/try-on`: `Authorization: Bearer <private access code>` and JSON `{ "personImage": "data:image/jpeg;base64,...", "garmentImage": "data:image/jpeg;base64,...", "category": "outerwear", "consent": true }`.
- Success: `{ "imageDataUrl": "data:image/jpeg;base64,...", "disclaimer": "..." }`.
- Failure: `{ "code": "...", "message": "..." }` with a suitable HTTP status.

Only tops, bottoms, dresses, and outerwear are supported. Each decoded JPEG must be at most 1 MiB. The app resizes/compresses images before upload. Requests are limited to 3.5 MiB and generated JSON responses remain under 4 MB to leave room below the deployment's response limit. Remote image URLs are not accepted, preventing server-side URL fetching. Input headers/base64 are checked; the image provider remains responsible for decoding and validating the image content.

The prompt preserves identity and body shape, and the result is explicitly a generated styling preview—not an exact fit, size, or tailoring prediction. Input photos and results are held in memory by this backend, not written to files or a database. Photos are sent to OpenAI; do not promise that they never leave the device or that the provider has zero retention. Avoid enabling request-body/header logging in your deployment. See the [OpenAI image edit API](https://developers.openai.com/api/reference/resources/images/methods/edit) and [API data controls](https://developers.openai.com/api/docs/guides/your-data).

## Before a public Play Store launch

This access code protects a **private beta**, not a multi-user production service. Do not put the shared code in a public app or distribute it to untrusted users. Replace it with verified per-user authentication, durable per-user and project-wide quotas, rate limits, and an atomic paid-credit reservation before opening access. Set provider billing controls now. The pre-existing Claude routes also require their own authentication/rate limits before public exposure.

The client and server do not automatically retry billable generation requests. If a mobile connection is interrupted or Vercel times out, OpenAI may still finish and bill the request even though the app cannot retrieve its response. Aborting is best-effort. A production release should use durable job tracking/idempotency, background processing, protected image storage, and recovery of completed results instead of synchronous generation.
