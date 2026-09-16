# Wardrobe & Outfit Planner AI

> **Backend deployment:** This GitHub repository publishes the `backend/` folder.
> Set Vercel's Root Directory to `backend`. Follow [the backend deployment guide](backend/README.md)
> for Google Gemini try-on keys, private access codes, and verification. The React Native
> app described below is present locally but intentionally not tracked in this repository.

A React Native (Expo) app: photograph your clothes, get AI-generated outfit
suggestions by occasion/weather, monetized via Google Play subscriptions.

## What's here

```
WardrobeAI/
├── App.tsx                      # entry point
├── app.json                     # Expo config (package name, permissions)
├── src/
│   ├── screens/                 # Onboarding, Home, Wardrobe, AddItem, OutfitGenerator, Paywall, Profile
│   ├── components/ClothingCard.tsx
│   ├── context/WardrobeContext.tsx   # local state + AsyncStorage persistence
│   ├── services/api.ts          # calls YOUR backend (never call AI APIs directly from the app)
│   ├── services/iap.ts          # react-native-iap wrapper for Play subscriptions
│   ├── navigation/AppNavigator.tsx
│   └── theme/colors.ts
└── backend/
    ├── server.js                # Express server
    ├── routes/wardrobe.js       # POST /api/wardrobe/tag  (image -> category/color/season/tags)
    ├── routes/outfit.js         # POST /api/outfit/generate (wardrobe -> suggested outfit)
    └── services/aiService.js    # Claude API calls live here
```

## Why there's a backend at all

Never put your Claude/OpenAI API key inside the mobile app — anyone can
decompile an APK and extract it in minutes, then run up your bill. The app
talks to your backend; your backend holds the key and talks to the AI.

## Running it locally

### Current UI preview

The app now has Today, searchable Closet, Try on, Style, and Saved tabs.
Onboarding offers a personal closet or an optional photo-based sample collection.
Pieces can be edited or removed with undo; looks can be saved, favorited, and marked worn.

Style currently uses a category-aware on-device combination builder. It does not
call the AI backend or consume AI credits. Try on now connects to Google Gemini
Nano Banana 2 (`gemini-3.1-flash-image`) through the backend: choose a garment and a person photo, enter the
private test access code, consent to upload, then generate and compare the result
with the original. The screen checks the deployed backend configuration and
explains missing routes or credentials instead of showing a permanently disabled
placeholder. Sample photos require an internet connection.

**To enable real try-on on your existing Vercel deployment:** deploy the updated
`backend` directory, configure server-only `GEMINI_API_KEY` and a separate random
`TRY_ON_ACCESS_TOKEN` of at least 24 characters, allow a 300-second function
duration, and redeploy. Enter only the private access code in the app—not the
Gemini key. Check `/api/try-on/config` on the deployment; `available: true` means
configuration is present, not that billing/model access has been verified.
See [backend setup and deployment instructions](backend/README.md).
Nano Banana 2 API generation requires a billing-enabled Google project; it is not
unlimited free image generation. No shared assistant credentials are supplied.
Node.js is not changed. Reload the updated mobile app as well as redeploying the
backend: its consent now explicitly names Google Gemini. Old OpenAI-consent
requests are rejected instead of silently sending photos to a different provider.

This is a private-beta integration. Do not distribute the shared access code in a
public app. Verified user authentication, durable usage limits and job recovery
are needed before public launch. AI previews are illustrative, not fit guarantees.
Photos are uploaded only after consent and an explicit generation action.

Check the UI code with `npm run typecheck`, the local styling rules with
`node scripts/check-local-stylist.cjs`, and try-on client behavior with
`node --test scripts/check-try-on.cjs`. Run `npm test` from `backend` for backend
tests. Try-on tests mock the provider and do not send photos or use API credits.
Preview in Expo Go SDK 57 using
`npx expo start --clear`, or in the browser using `npm run web`.

This project targets Expo SDK 57. Use the SDK 57 version of Expo Go on Android.
After upgrading, stop any older Metro server and run `npx expo start --clear`,
then scan the new QR code. Android Studio is not needed for Expo Go testing.
Use `npx expo start --tunnel` if your phone cannot connect over Wi-Fi.

SDK 57 dependencies declare Node support as `^20.19.4 || ^22.13.0 || ^24.3.0 || >=25.0.0`.
The existing Node installation has not been changed; Node 22.12 is outside that range.
Purchase code is not loaded in Expo Go or web previews; real purchases still require
a native development build and production receipt validation.

**Frontend:**
```bash
cd WardrobeAI
npm install
npx expo start
```
Scan the QR with Expo Go on your Android phone. Note: `react-native-iap`
purchase flows do NOT work in Expo Go — you need a development build
(`npx expo run:android`) or EAS Build to test real purchases.

**Backend:**
```bash
cd WardrobeAI/backend
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```
Then update `API_BASE_URL` in `src/services/api.ts` to point at it (use
your machine's LAN IP for local testing, e.g. `http://192.168.1.5:3001`,
or a deployed URL like Railway/Render/EC2 once you ship).

## What's real vs. what you still need to add

**Working now:**
- Full navigation, wardrobe CRUD, camera/gallery picker, local persistence
- Backend endpoints that call Claude for image tagging and outfit reasoning
- IAP scaffolding wired to `react-native-iap` with a free-tier daily limit gate

**You still need to:**
1. **App icons/splash** — replace the placeholder assets in `assets/`
2. **Play Console setup** — create the app, set up a Play Console developer
   account ($25 one-time fee), create subscription products matching the
   SKUs in `src/services/iap.ts` (`wardrobe_ai_pro_monthly`, `wardrobe_ai_pro_yearly`)
3. **Server-side receipt verification** — right now purchases are trusted
   client-side after `finishTransaction`. Before launch, add a
   `/api/iap/verify` endpoint that calls the Google Play Developer API to
   verify each purchase token server-side, or fraudulent/refunded purchases
   will still grant Pro access forever
4. **Deploy the backend** somewhere persistent (Render, Railway, Fly.io, AWS)
   — given your AWS background, an EC2 instance or Lambda + API Gateway
   would both work fine
5. **EAS Build + signing** for a release APK/AAB (`eas build --platform android`)
6. **Testing on a real device** with a development build, since Expo Go
   can't do in-app purchases

## Monetization notes

- Free tier: 3 AI outfit generations/day (adjust `dailyFreeLimit` in
  `WardrobeContext.tsx`)
- Pro: unlimited generations, monthly or yearly subscription
- Google Play takes 15% of the first $1M/year in subscription revenue,
  30% after — price accordingly
- Consider a 3-7 day free trial on the yearly plan (configurable in Play
  Console) to boost conversion

## Cost control

Each outfit generation and each item tagged costs one Claude API call.
At scale, cache tagging results (never re-tag the same image) and consider
batching or a cheaper model for tagging if volume grows.
