# Wardrobe AI backend

Try-on uses Fal's dedicated `fal-ai/image-apps-v2/virtual-try-on` endpoint. It receives separate person and garment images, preserving the person’s pose while generating the preview.

## Vercel configuration

Set these server-only Production environment variables, then redeploy:

- `FAL_KEY`: API key created in the Fal dashboard. Do not expose it in the React Native app or an `EXPO_PUBLIC_*` variable.
- `TRY_ON_ACCESS_TOKEN`: a separate private-beta code, 24–512 printable characters. It must not be the Fal key.

`GET /api/try-on/config` validates configuration without revealing keys or calling Fal. `POST /api/try-on` requires the beta access code and explicit `consentProvider: "fal"` before either photo is processed.

Images are sent as data URIs directly to Fal’s virtual try-on endpoint. The output is downloaded from Fal’s HTTPS media host, checked as a JPEG/PNG, then returned to the app as a data URI. Nothing is written to this server’s disk or database.

Fal is paid, usage-based inference. Before enabling general access, set account spending limits and confirm current endpoint pricing in the Fal dashboard. Run local tests with `npm test`; tests use dummy credentials and mocked Fal responses only.
