# Wardrobe AI backend

The try-on endpoint uses Hugging Face Inference Providers for an experimental image-to-image styling preview. The default model is `black-forest-labs/FLUX.2-klein-4B`; set `HF_IMAGE_MODEL` and `HF_PROVIDER` in Vercel if you choose another compatible model/provider.

## Vercel configuration

Set these server-only variables in the Vercel environment and redeploy:

- `HF_TOKEN`: a Hugging Face user token with Inference Providers permission. Never expose it in Expo or `EXPO_PUBLIC_*` variables.
- `HF_IMAGE_MODEL`: defaults to `black-forest-labs/FLUX.2-klein-4B`.
- `HF_PROVIDER`: defaults to `fal-ai`.
- `TRY_ON_ACCESS_TOKEN`: a separate private beta code, 24–512 printable characters. It is not the HF token.

Hugging Face documents a small, changeable free monthly inference credit; it is a trial allowance, not unlimited free production generation. Provider availability and model support can change.

`GET /api/try-on/config` reports safe readiness without exposing credentials or invoking a provider. `POST /api/try-on` requires the private access code, explicit `consentProvider: "huggingface"`, a JPEG person photo and garment photo, and a supported category.

The current Hugging Face image-to-image API accepts one source image. This integration therefore provides a styling-preview prototype using the person image and garment category; it does not guarantee exact garment transfer or fit. A production-grade two-image virtual try-on model/provider should be added separately after evaluating its license, privacy, capacity and cost.

Run the backend tests with `npm test`. Tests use dummy credentials and mocked provider responses; they never spend inference credits.
