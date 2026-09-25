# Google Play preview packs

The Android app now uses **Google Play consumable one-time products**, not Razorpay or subscriptions. The existing pack layout is retained. iOS/web/Expo Go checkout is deliberately disabled; Apple IAP is a separate integration.

## 1. Play Console

Confirm the permanent package name before your first Play upload. The current app.json value is `com.yourcompany.wardrobeai`; do not rename an already-published application. The backend `GOOGLE_PLAY_PACKAGE_NAME` must match exactly.

Create and activate these **one-time products** with a normal **buy** purchase option (not rental, preorder, subscription or promotional offer). Disable multi-quantity purchasing: this version verifies quantity exactly one. Set Indian prices and availability in Play Console:

| Product ID | Pack | Indian price to configure | Credits |
| --- | --- | --- | --- |
| `wardrobe_preview_starter` | Starter | INR 250 | 1 |
| `wardrobe_preview_standard` | Standard | INR 500 | 3 |
| `wardrobe_preview_premium` | Premium | INR 1000 | 10 |

The app displays Google's localized price for the selected buy option. Editing a number in app source does NOT change store pricing. No renewal occurs. UPI availability/payment method selection is controlled by Google Play, not the app.

## 2. Google API credentials and Vercel

Enable the **Google Play Android Developer API** in your Google Cloud project. Create a service account and add its email as a user in Play Console with access limited to this app and the purchase/order permissions required to read purchases and consume orders (including View financial data and Manage orders and subscriptions). Do not give general project-owner access just for billing.

Set backend-only environment variables in Vercel, then redeploy:

```dotenv
GOOGLE_PLAY_PACKAGE_NAME=com.yourcompany.wardrobeai
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=<the entire service-account JSON object>
MONGODB_URI=<your existing Atlas URI>
MONGODB_DB_NAME=wardrobe_ai
FAL_KEY=<your existing server-only key>
```

The JSON must contain real line breaks encoded as `\n` inside its private_key string, as in the downloaded file. Use Vercel's secret field; do not paste secrets into Git, screenshots, EXPO_PUBLIC variables, or the app. `/api/payments/config` checks configuration syntax only, not Play permissions or product activation.

Razorpay keys and `ALLOW_TEST_PAYMENTS` are not used by the new checkout. `/api/payments/orders` and the old `/verify` now return APP_UPDATE_REQUIRED (410). The old Razorpay service remains as historical code with regression tests, but is not reachable through checkout routes. Previously verified session-bound **live** Razorpay credits remain usable; test or unidentified legacy records cannot fund Fal.

## 3. Build and test

Keep `EXPO_PUBLIC_API_BASE_URL` pointing at the intended HTTPS backend when building. Google Play account binding includes the package and the backend's authenticated session; do not switch backends midway through a purchase.

```powershell
npm install
npm run typecheck
npm run check:play-billing
cd backend
npm test
cd ..
npx eas-cli@latest build --platform android --profile production --clear-cache
```

Upload the resulting **AAB** to an internal testing track. Add license testers in Play Console and track testers, then install through the Play testing link using the tester's Google account. A sideloaded APK or Expo Go is not the acceptance test. A native rebuild is required because the app now uses `expo-iap` 5.6.3 instead of the patched legacy react-native-iap/Razorpay modules. Node.js has not been changed; the installed RN version still declares a newer Node minor than local 22.12.0.

Test all three packs, cancellation, pending payment then completion, network loss during confirmation, force-close/reopen, repeated recovery, and a second purchase of the same pack. Verify that each real purchase grants 1/3/10 exactly once and cannot be replayed to refill spent credits.

**License-test purchases are successfully verified/consumed but stored as `google-play-test`; they add zero spendable Fal credits in every environment, including Production.** The screen explicitly reports test success. `Recover purchases` and launch/resume reconcile unfinished purchases on the same app installation. Already-consumed credits are read from MongoDB, not restored from Google. This does NOT restore a lost guest identity after uninstall/reinstall or onto another device.

## Implementation and remaining launch work

- Authenticated `/api/payments/google-play/account` supplies a hashed account binding for checkout.
- `/api/payments/google-play/verify` looks up the token via Google's ProductPurchaseV2 API using the configured package, not a client-selected package. It checks PURCHASED state, SKU, quantity, remaining refundable quantity and account binding.
- MongoDB inserts a token-hash-keyed ledger entry once. Retries cannot refill it. Raw purchase tokens and service credentials are not returned in errors or persisted in the ledger.
- After durable credit grant, the backend calls Google's consume API (which also acknowledges the purchase). Failed finalization can retry from the unconsumed purchase held by Google; the client never grants credits or finishes a transaction itself.
- Test and live credits are separate; only Google live and previously verified Razorpay live credits fund Fal.
- The unused old Kotlin patch and its postinstall verifier were removed with the legacy native dependency.

**Not yet a public-launch sign-off:** automatic Google real-time developer notifications/voided-purchase refund reconciliation, server-initiated recovery for purchases never retried by the app, cross-device account recovery, and persistent Fal generation jobs still need implementation. A refund occurring after credit grant is not yet automatically deducted. Failed/interrupted Fal generation can still spend one credit. Privacy/reporting features and actual Play review are separate. Do not claim live checkout or native compilation is validated by the mocked tests.

Official references: [Google billing security](https://developer.android.com/google/play/billing/security), [ProductPurchaseV2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2), [consume API](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume), [test purchases](https://developer.android.com/google/play/billing/test).
