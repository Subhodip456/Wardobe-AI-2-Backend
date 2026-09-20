# Wardrobe AI backend

Try-on uses Fal's dedicated `fal-ai/image-apps-v2/virtual-try-on` endpoint. It receives separate person and garment images, preserving the person’s pose while generating the preview.

## Vercel configuration

Set these server-only Production environment variables, then redeploy:

- `FAL_KEY`: API key created in the Fal dashboard. Do not expose it in the React Native app or an `EXPO_PUBLIC_*` variable.
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: Razorpay live-mode keys. The secret never leaves Vercel.
- `MONGODB_URI`: your MongoDB connection string. Keep it server-only. The database user needs read/write and index-creation access to the selected database.
- `MONGODB_DB_NAME`: optional database name; defaults to `wardrobe_ai`.

`GET /api/payments/config` exposes Starter ₹250 / one preview, Standard ₹500 / three previews, and Premium ₹1000 / ten previews. The app creates an order with Razorpay, then the backend verifies Razorpay's payment signature before crediting the device. Credits are decremented atomically in MongoDB immediately before an AI try-on request.

Images are sent as data URIs directly to Fal’s virtual try-on endpoint. The generated preview is returned as an allowlisted Fal HTTPS media URL. Images are not stored in MongoDB. Payment orders and their device-bound remaining credits are stored in `try_on_payment_orders`.

Each order uses its Razorpay order ID as the unique document ID. Verification activates only a pending order; paid records are retained, including exhausted packs, to prevent replaying a payment to refill credits. Atomic conditional decrements prevent overspending. Multiple packs add together, with older packs consumed first. This design works with standalone MongoDB as well as Atlas and does not require multi-document transactions. Warm Vercel invocations reuse a small connection pool.

Ensure your MongoDB server is reachable from Vercel (a localhost URI is only usable for local development). For Atlas, configure database-user permissions and network access for your deployment. Set the variables above in Vercel and redeploy. `/api/payments/config` checks presence of configuration only; reading `/api/payments/credits` with a valid device header exercises the database connection. No MongoDB credentials belong in the mobile app.

Existing Redis balances are not migrated automatically. If you have already accepted payments using the previous store, migrate those orders and balances before enabling MongoDB in production. Credits still belong to an app installation; account-based purchase restoration is a separate feature.

Fal is paid, usage-based inference. Before enabling general access, set account spending limits and confirm current endpoint pricing in the Fal dashboard. Configure Razorpay webhooks separately for reconciliation and refunds; client-side success is never used to grant credits.

Run `npm test` from `backend` for offline service and regression tests. The optional MongoDB integration suite runs only with `RUN_MONGODB_INTEGRATION=1`; it starts an isolated temporary MongoDB server to test concurrent verification, replay protection, spending limits, persistence, and database failures. Its first run downloads a large MongoDB executable. It never uses your Atlas cluster or real payments. Normal tests and deployment do not download or launch a database.

For the existing Atlas cluster, use `mongodb+srv://subhodip:<db_password>@cluster0.8jtso.mongodb.net/?retryWrites=true&w=majority` as the URI template. Replace `<db_password>` privately in Vercel with the URL-encoded database-user password. Keep `MONGODB_DB_NAME=wardrobe_ai` or set the database you want to use. This repository contains only a placeholder, not a working credential.
