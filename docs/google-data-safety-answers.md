# Google Play — Data Safety answer sheet

> **What this is.** The answers to enter in Play Console → *App content → Data
> safety*, transcribed from the code-verified `docs/data-inventory.md`
> (re-verified 2026-07-26) and Google's Data Safety definitions.
>
> **Not legal advice** — engineering transcription. Judgment calls are flagged
> `⚠️`; resolve them before you submit.

---

## 0. Section-level answers

- **Does your app collect or share any of the required user data types?** → **Yes.**
- **Is all of the user data collected by your app encrypted in transit?** → **Yes**
  (HTTPS everywhere).
- **Do you provide a way for users to request that their data is deleted?** → **Yes** —
  in-app account deletion (`DELETE /me`, immediate hard delete) **and** the web
  deletion path. Provide that URL in the form.
- **Is your app designed for children / does it comply with the Families policy?**
  → **No, not designed for children** (age rating 13+). Answer the Families
  questions accordingly.
- **Independent security review** (optional badge) → leave unset unless you've had one.

---

## 1. How Google defines "Shared" (read this first — it flips several answers)

Google's **"Data shared"** = user data transferred to a **third party**. It
**excludes** transfers to a **service provider** that processes the data *on your
behalf under your instructions*. It also excludes transfers that are user-initiated,
for legal reasons, or of anonymized data.

**All of Meroa's recipients are service providers** (OpenAI/AI, RevenueCat,
Sentry, Expo push, Railway) — they process on our behalf. So under Google's
definition, the correct answer for all of them is **Collected = Yes, Shared = No**.
The AI provider is **OpenAI**, which does not train on API data by default and
processes in the US, so it's a genuine processor — this was the previously-open
question (DeepSeek would *not* have qualified, which is why it was replaced,
2026-07-26). This form asks the narrow legal "sharing" question, so it answers
**No** across the board.

---

## 2. Data types

For every type: **Encrypted in transit = Yes.** "Optional" = user can use the app
without it; "Required" = core.

| Google category → data type | Collected | Shared | Purpose(s) | Req/Opt | Notes |
|---|---|---|---|---|---|
| **Personal info → Name** | Yes | No | App functionality | Optional | Apple sign-in name, only if the user chooses to share it → `users.displayName` |
| **Personal info → User IDs** | Yes | No | Account management, App functionality | Required | Apple user id (Sign in with Apple login identity) + internal `userId` UUID → RevenueCat (processor) |
| **Messages → Other in-app messages** | Yes | **No** | App functionality | Required | AI provider (OpenAI) is a no-training processor → not "sharing" (resolved 2026-07-26). |
| **App activity → Other user-generated content** | Yes | No | App functionality | Required | tasks, goals, records, memories |
| **Financial info → Purchase history** | Yes | No | App functionality (subscription) | Required | `entitlements` via RevenueCat (processor) + the store handles the actual purchase (user-initiated) |
| **App info & performance → Crash logs** | Yes | No | App functionality | Required | Sentry (processor) |
| **App info & performance → Diagnostics** | Yes | No | App functionality | Required | Sentry (processor) |
| **Device or other IDs** ⚠️ | Yes | No | App functionality (notifications) | **Optional** | Expo **push token**; collected only if the user enables notifications; Expo delivers on our behalf |

**Not collected** (leave every other Google type unchecked): **Phone number** (the
app is Sign in with Apple only — the phone/OTP path is unreachable from the shipping
client), **Email address** (the Apple `EMAIL` scope reaches the server but is never
stored → transient exemption), Location, Health & fitness (as a declared type),
Photos/videos, Audio, Files & docs, Calendar, Contacts, Web browsing, App
interactions/search-history/installed-apps, advertising ID. **No data is used for
advertising or tracking.**

---

## 3. Judgment calls & must-verify

- **✅ Messages → "Shared = No" (resolved 2026-07-26).** The AI provider is
  **OpenAI**, which does not train on API data by default and processes in the US
  → a processor → not "sharing." (DeepSeek was replaced precisely because its API
  terms allowed training + PRC retention, which would have forced **Shared = Yes**.)
  Re-confirm the provider hasn't changed before submitting.
- **⚠️ Push token as "Device or other IDs."** Declared conservatively because we
  store it linked to the user. Optional (notification-permission-gated). Never
  used for tracking/ads.
- **Purchase history "Shared = No":** RevenueCat is a processor; the store
  purchase itself is user-initiated (excluded). If you'd rather be conservative,
  marking it Shared → RevenueCat is harmless.
- **⚠️ Auth = Sign in with Apple (reconciled 2026-07-30).** Phone number was
  dropped (Apple-only client) and replaced by **Name** (optional, if shared) +
  **User IDs** (the Apple user id). Email is requested via scope but not stored →
  not declared. Keep this in sync with `app-privacy-answers.md` and `privacy-draft.md`.
- **Reconcile with the inventory.** `data-inventory.md §5` lists recipients in a
  "shared with 3rd party" column; that's the *who-receives-it* view, not Google's
  *legal-sharing* view. This sheet is the one to transcribe into Play Console.

---

## 4. Cross-check before submitting

1. Re-verify against `data-inventory.md` (SDKs move).
2. Resolve the AI-provider sharing flag (§3) — it must match `privacy-draft.md §3`.
3. Confirm the three consumer-facing stories agree: **this sheet**, the **Apple
   App Privacy** answers (`app-privacy-answers.md`), and the **privacy policy**.
4. Confirm the account-deletion URL is live before you point the form at it.
