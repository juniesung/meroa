# Auth swap scope — Firebase Phone Auth (replaces the SMS-OTP stub)

## Why

Login is currently a **console stub**: `server/src/sms/sender.ts`'s
`devConsoleSmsSender` just logs the OTP, so no real user can receive a code and
sign in — a hard launch blocker. Firebase Phone Auth fixes it *and* keeps Meroa's
**phone-keyed identity model**, so it's a contained swap, not a rewrite. Google
handles SMS delivery + carrier compliance (no A2P 10DLC wait), and the same
Firebase project unlocks web login later (same phone identity across app + web).

## What STAYS (the whole point — minimal churn)

- **Phone-keyed data model** — `users.phoneE164` unchanged. Firebase gives you a
  *verified* phone number; you upsert exactly as today.
- **Your JWT session system** — `signAccessToken` / refresh tokens / `sessions`
  table / `requireAuth` / `/auth/refresh` / `/auth/logout` — all unchanged.
  Firebase is only the phone-verification front door; you still mint your own session.
- **Client `AuthProvider`** (`src/lib/auth/AuthProvider.tsx`) — `signIn(tokens)`
  still stores *your* access/refresh tokens. Token store, session-expiry handling,
  refresh — untouched.
- **Every authed route + the entire app** — unchanged.

## What CHANGES

### Server
1. **New endpoint `POST /auth/firebase`** (`routes/auth.ts`): verify the Firebase
   ID token with the Firebase Admin SDK (`verifyIdToken`), read the verified
   `phone_number` claim, then run the **existing** upsert + session logic.
   - **Refactor to reuse:** extract the block in `routes/auth.ts:63–126` (find-or-
     create user + entitlement + welcome conversation/message, timezone refresh,
     `signAccessToken` + `sessions` insert, return `{accessToken, refreshToken,
     isNewUser, user}`) into a shared `signInWithPhone(phone, timezone)` helper.
     `/auth/firebase` calls it; nothing else changes.
2. **Add `firebase-admin`** + init from a service account (env:
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Railway
   secrets). One small `lib/firebase-admin.ts`.
3. **Retire the DIY login OTP** for login: `/auth/otp/request` + `/auth/otp/verify`
   become dead for the app once the client stops calling them. ⚠️ Do NOT delete
   `lib/otp.ts` — it's also used by the **web account-deletion flow**
   (`routes/legal.ts`), see the wrinkle below.

### Client (Expo app)
1. **Add `@react-native-firebase/app` + `@react-native-firebase/auth`**, add them
   to `app.json` `plugins`, drop in `GoogleService-Info.plist`, and **rebuild the
   dev client** (native module — you already build dev clients, so this is a
   rebuild, not new infra).
2. **`src/app/(auth)/sign-in.tsx`** — replace `api.requestOtp(phone)` with Firebase
   `auth().signInWithPhoneNumber(phone)`; stash the returned `confirmation`, go to verify.
3. **`src/app/(auth)/verify.tsx`** — replace `api.verifyOtp(phone, code)` with
   `confirmation.confirm(code)` → `user.getIdToken()` → `api.firebaseSignIn(idToken,
   timezone)` → `signIn(result)` (same `AuthProvider.signIn` as today). Resend =
   re-run `signInWithPhoneNumber`.
4. **`src/lib/api/client.ts`** — replace `requestOtp`/`verifyOtp` with one
   `firebaseSignIn(idToken, timezone)` → `POST /auth/firebase`. `refresh`/`logout`
   unchanged.

## Firebase console setup (human, one-time)

- Create a Firebase project; add an **iOS app** (bundle `com.meroa.app`) → download
  `GoogleService-Info.plist`.
- **Enable Phone Authentication** in Firebase Auth.
- Upload an **APNs auth key** so iOS uses silent-push app verification (avoids the
  reCAPTCHA fallback — you already have push set up, so this aligns).
- **Abuse protection (mandatory):** enable **App Check**, an **SMS-region
  allowlist**, and per-number **quotas** — Firebase phone auth is an SMS-pump/toll-
  fraud target.
- Generate a **service account key** for the server Admin SDK.
- Add **test phone numbers** (fixed code, no real SMS) — hand one to App Review in
  the notes so the reviewer can sign in without a phone.

## The one wrinkle (note, not a blocker)

`lib/otp.ts`'s `issueOtpForPhone` also powers the **web account-deletion** page
(`/account/delete`, a Google-Play requirement). That flow already can't send its
code (same SMS stub), so it's non-functional today regardless — and it's
**Google-Play-gated, not needed for the iOS launch** (the in-app "Delete account"
in the You tab works via the authed session, no OTP). Leave `lib/otp.ts` in place;
solve web deletion when Android/SMS is on the table.

## Effort & risk

- **~1 focused day** of code + the Firebase console setup. Contained because the
  data model + session system are untouched.
- **Risk:** the native module needs a dev-client rebuild; toll-fraud protection
  must be turned on; Admin credentials go in Railway secrets. All standard.

## Verification

- Dev client: enter a **Firebase test number** → fixed code → lands signed in;
  confirm a **real** number receives an SMS and signs in on device.
- New user → gets the welcome conversation + `free` entitlement (reused logic);
  returning user → same account, timezone refreshed.
- `POST /auth/firebase` with a forged/expired token → 401 (Admin `verifyIdToken`
  rejects). `/auth/refresh` + `/auth/logout` still work (unchanged).
- `npm run battery` unaffected (it mints tokens via `dev:token`, not the OTP path).
