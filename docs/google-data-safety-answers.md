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

**All of Meroa's recipients are service providers** (DeepSeek/AI, RevenueCat,
Sentry, Expo push, Railway) — they process on our behalf. So under Google's
definition, the correct answer for those is **Collected = Yes, Shared = No**,
*provided* each relationship is a genuine processor relationship (standard API
terms / a DPA). ⚠️ **This is the opposite of the conservative "shared" column in
`data-inventory.md §5`** — that column listed the *recipient*; this form asks the
narrower legal question. Confirm the processor terms below, then answer per this
section.

---

## 2. Data types

For every type: **Encrypted in transit = Yes.** "Optional" = user can use the app
without it; "Required" = core.

| Google category → data type | Collected | Shared | Purpose(s) | Req/Opt | Notes |
|---|---|---|---|---|---|
| **Personal info → Phone number** | Yes | No | Account management, App functionality | Required | Login identity + OTP |
| **Messages → Other in-app messages** | Yes | **No ⚠️** | App functionality | Required | ⚠️ Shared flips to **Yes** if the AI provider uses message content for its **own** purposes (training/retention). See §3. |
| **App activity → Other user-generated content** | Yes | No | App functionality | Required | tasks, goals, records, memories |
| **Financial info → Purchase history** | Yes | No | App functionality (subscription) | Required | `entitlements` via RevenueCat (processor) + the store handles the actual purchase (user-initiated) |
| **App info & performance → Crash logs** | Yes | No | App functionality | Required | Sentry (processor) |
| **App info & performance → Diagnostics** | Yes | No | App functionality | Required | Sentry (processor) |
| **Device or other IDs** ⚠️ | Yes | No | App functionality (notifications) | **Optional** | Expo **push token**; collected only if the user enables notifications; Expo delivers on our behalf |

**Not collected** (leave every other Google type unchecked): Location, Health &
fitness (as a declared type), Photos/videos, Audio, Files & docs, Calendar,
Contacts, Web browsing, App interactions/search-history/installed-apps,
advertising ID. **No data is used for advertising or tracking.**

---

## 3. Judgment calls & must-verify

- **⚠️ Messages → "Shared" hinges on the AI provider's data terms.** If the AI
  provider's API guarantees it does **not** train on or independently use/retain
  your content, it's a processor → **Shared = No**. If it may use the content for
  its own purposes, → **Shared = Yes** (and the privacy-policy "on our behalf"
  line must change — same flag as `privacy-draft.md §3`). **Verify the provider's
  API data policy before submitting.** This is the one answer most likely to be
  wrong.
- **⚠️ Push token as "Device or other IDs."** Declared conservatively because we
  store it linked to the user. Optional (notification-permission-gated). Never
  used for tracking/ads.
- **Purchase history "Shared = No":** RevenueCat is a processor; the store
  purchase itself is user-initiated (excluded). If you'd rather be conservative,
  marking it Shared → RevenueCat is harmless.
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
