# Wardrobe AI backend

Try-on uses Fal's dedicated `fal-ai/image-apps-v2/virtual-try-on` endpoint. It receives separate person and garment images, preserving the person’s pose while generating the preview.

## Vercel configuration

Set these server-only Production environment variables, then redeploy:

- `FAL_KEY`: API key created in the Fal dashboard. Do not expose it in the React Native app or an `EXPO_PUBLIC_*` variable.
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: Razorpay live-mode keys. The secret never leaves Vercel.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: a write-capable Upstash Redis REST connection, used for durable paid-preview credits.

`GET /api/payments/config` exposes Starter ₹250 / one preview, Standard ₹500 / three previews, and Premium ₹1000 / ten previews. The app creates an order with Razorpay, then the backend verifies Razorpay's payment signature before crediting the device. Credits are decremented atomically in Redis immediately before an AI try-on request.

Images are sent as data URIs directly to Fal’s virtual try-on endpoint. The generated preview is returned as an allowlisted Fal HTTPS media URL. Nothing is written to this server’s disk or database; only anonymous device-bound credit balances and short-lived payment orders are stored in Redis.

Fal is paid, usage-based inference. Before enabling general access, set account spending limits and confirm current endpoint pricing in the Fal dashboard. Configure Razorpay webhooks separately for reconciliation and refunds; client-side success is never used to grant credits. Run local tests with `npm test`; tests use dummy credentials and mocked provider responses only.
