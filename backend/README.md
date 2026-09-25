# Wardrobe AI backend

Try-on uses Fal's dedicated `fal-ai/image-apps-v2/virtual-try-on` endpoint. It receives separate person and garment images, preserving the person’s pose while generating the preview.

## Vercel configuration

Set these server-only Production environment variables, then redeploy:

- `FAL_KEY`: API key created in the Fal dashboard. Do not expose it in the React Native app or an `EXPO_PUBLIC_*` variable.
- `GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: matching Android package and server-only Google Play service-account credentials. Follow [Google Play setup](GOOGLE_PLAY_SETUP.md) to configure products, prices and permissions.
- `MONGODB_URI`: your MongoDB connection string. Keep it server-only. The database user needs read/write and index-creation access to the selected database.
- `MONGODB_DB_NAME`: optional database name; defaults to `wardrobe_ai`.

`GET /api/payments/config` exposes Google Play product IDs for Starter / one preview, Standard / three previews, and Premium / ten previews. Configure ₹250, ₹500 and ₹1000 in Play Console; the client displays the store's localized prices. The backend verifies Google purchase state, SKU, quantity, account binding and refund quantity before granting credits once and consuming the purchase. Credits are decremented atomically in MongoDB immediately before an AI try-on request.

Images are sent as data URIs directly to Fal’s virtual try-on endpoint after an in-app consent prompt. The generated preview is returned as an allowlisted Fal HTTPS media URL. These are not authenticated private image links: anyone with a link may be able to view it. Images are not stored in MongoDB. Payment orders and their session-bound remaining credits are stored in `try_on_payment_orders`.

Play orders use a package-and-purchase-token hash as the unique document ID. Verification inserts a ledger entry once; paid records are retained, including exhausted packs, to prevent refilling credits by replay. Atomic conditional decrements prevent overspending. New Google live packs are used first, followed by previously verified Razorpay live packs. This works with standalone MongoDB and Atlas without multi-document transactions. Warm Vercel invocations reuse a small connection pool.

Ensure your MongoDB server is reachable from Vercel. For Atlas, configure database-user permissions and network access for your deployment. `/api/payments/config` checks configuration only; reading `/api/payments/credits` with a valid bearer session exercises the database connection. No MongoDB credentials belong in the mobile app.

Existing Redis and device-only MongoDB balances are not migrated automatically. Old orders without an explicit `billingMode` are excluded. Before rollout, verify payment ownership and mode server-side and arrange a controlled migration to new session subjects. Never offer an endpoint that claims an old balance using only a client-supplied device UUID. Existing records are not deleted. Account-based purchase restoration is a separate feature.

Fal is paid, usage-based inference. Set provider account spending limits and edge firewall/rate limits before general access. Signed webhook reconciliation for refunds/disputes and payment recovery is NOT implemented yet. A refund after credits were granted does not automatically revoke them. Client-side success alone never grants credits.

## Security rollout (app and backend must be updated together)

- `POST /api/session` creates a random 256-bit bearer credential and a server-selected UUID. Only its SHA-256 hash is stored in `app_sessions`. Credentials expire after one year; expired or revoked sessions fail closed. For administrative revocation set `revoked: true` on the appropriate session document. There is no public admin endpoint.
- The mobile app stores credentials using Expo SecureStore, not AsyncStorage. Web previews keep credentials in memory only; refreshing loses that guest identity and web checkout remains disabled. Do not use web previews for paid balances. Android uninstall/storage loss can lose a guest credential; do not promise account recovery.
- All `/api` routes except session creation and the two read-only config endpoints require bearer authentication. The old `X-Wardrobe-Device-ID` header grants no access. Neither session creation nor request bodies choose the authenticated subject.
- MongoDB `request_limits` enforces shared fixed-window limits across serverless instances: 60 requests/minute per session, 10 writes/minute, 10 payment orders/hour, 50 AI requests/day per session, and 200 AI requests/day globally. Global registration defaults to 100 sessions/hour. `AI_DAILY_REQUEST_LIMIT` and `SESSION_HOURLY_LIMIT` can override the global limits with positive integers up to 100000. AI limits count attempts, including later-rejected inputs. These conservative circuit breakers limit spend but can deny service when exhausted; they do not replace edge DDoS protection, account authentication, or device attestation.
- Google Play license-test purchases are isolated as `google-play-test` and can NEVER fund paid Fal generation, even in Production. `ALLOW_TEST_PAYMENTS` no longer affects the app's payment flow. Legacy test credits are excluded as well.
- Set the app's `EXPO_PUBLIC_API_BASE_URL` to the matching HTTPS test or live backend. Rebuild installed native apps for `expo-iap`; Expo Go can preview UI but cannot run Google Play checkout. See [setup and testing](GOOGLE_PLAY_SETUP.md).
- `ALLOWED_WEB_ORIGINS` is a comma-separated exact web-origin allowlist, empty by default. Native apps don't need CORS permission. CORS is a browser control, not an authentication mechanism.
- MongoDB needs index creation permissions for session/rate-limit TTL indexes. Storage failures block protected requests, rather than bypassing enforcement.
- Old app builds stop working against the secured endpoints. Roll out privately first, reconcile legacy balances, and coordinate the backend/app update before release.

## Remaining public-launch work

Recoverable user accounts, Play Console setup and real-device billing tests, Google refund/voided-purchase reconciliation, idempotent generation jobs and interrupted-request recovery, private image storage/retention/deletion, privacy policy and Data Safety declarations, and a live environment/security audit are still required. Generations currently deduct a credit before the provider call, so failures can still consume credits; automatic refunds are unsafe until provider job status is reconciled. This change does not certify the app as fully secure or Play Store ready. Apple In-App Purchase has not been implemented in this Android billing change.

Run `npm test` from `backend` for offline service and regression tests. The optional MongoDB integration suite runs only with `RUN_MONGODB_INTEGRATION=1`; it starts an isolated temporary MongoDB server to test concurrent verification, replay protection, spending limits, persistence, and database failures. Its first run downloads a large MongoDB executable. It never uses your Atlas cluster or real payments. Normal tests and deployment do not download or launch a database.

For the existing Atlas cluster, use `mongodb+srv://subhodip:<db_password>@cluster0.8jtso.mongodb.net/?retryWrites=true&w=majority` as the URI template. Replace `<db_password>` privately in Vercel with the URL-encoded database-user password. Keep `MONGODB_DB_NAME=wardrobe_ai` or set the database you want to use. This repository contains only a placeholder, not a working credential.
