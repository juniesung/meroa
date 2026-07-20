# CLAUDE.md — Meroa

> Project constitution for AI coding agents (Claude Code / Cowork) and humans.
> This file is loaded on every turn. Keep it lean and durable. Detailed, per-phase
> work lives in `docs/phases/` — read the relevant phase file alongside this one.

---

## Getting started (read me first)

**Mental model:** every file here — this `CLAUDE.md` and all of `docs/phases/` — lives in
the repo permanently; nothing is added or removed per phase. `CLAUDE.md` auto-loads into
Claude Code every session. You make progress by pointing Claude Code at **one phase file
per session** and working it to its Definition of Done, in order.

**One-time machine setup (macOS)**

- Xcode + CLI tools: `xcode-select --install`, then `sudo xcodebuild -license accept`. Install an iOS Simulator runtime via Xcode → Settings → Components.
- [Homebrew](https://brew.sh) if you don't have it.
- Node.js 22 LTS (Expo needs Node regardless): install `nvm`, then `nvm install 22`.
- Local iOS build deps: `brew install watchman cocoapods`.
- **Claude Code** — native installer (recommended; auto-updates, no Node needed): `curl -fsSL https://claude.ai/install.sh | bash`. Requires a **paid** Claude plan (Pro/Max/Team/Enterprise) or a Console API key — the free chat plan doesn't include it. (npm alternative: `npm install -g @anthropic-ai/claude-code`, needs Node 22+, never `sudo`.)
- Later only (Android builds + store submission): `npm install -g eas-cli` + a free Expo account.

**Scaffold + install these docs (once)**

```bash
npx create-expo-app@latest meroa      # TypeScript template; also inits git
cd meroa
# move CLAUDE.md to the repo root and the docs/ folder inside the project
npx expo run:ios                       # local dev build to the simulator via Xcode
git add -A && git commit -m "scaffold + build docs"
```

**Per-phase loop** — from inside `meroa/`, run `claude` and start a **fresh session per
phase** so context stays focused. Prompt template:

> Read `CLAUDE.md` and `docs/phases/phase-N-<name>.md`. _(Phase 0 only: the app is already scaffolded — start from the theme + components.)_ Plan first and show me the plan before writing code. Work the task list and stop at the Definition of Done.

Then: review the plan → let it build → test on the simulator → `git commit` → tick that
phase's box in §9. Use Plan Mode (Shift+Tab) for anything substantial; commit at every
Definition of Done so you have clean checkpoints.

**Two things not to conflate**

- **Two "Claude"s.** _Claude Code_ is the tool that builds the app (uses your Pro/Max plan). The _model API that powers Meroa's in-app chat_ is separate — set up server-side in Phase 2 with its own key, never shipped in the app bundle (§3).
- **Builds.** You don't need EAS _cloud_ builds early: `npx expo run:ios` is already a dev build. iOS works locally now with Xcode; Android needs Android Studio or EAS — add it when you reach cross-platform testing. EAS cloud builds matter later for Android and TestFlight/store distribution.
- **Testing on a real phone (as of Phase 5).** Every dependency is an Expo SDK or core RN library, so **Expo Go runs the whole app** — no Xcode, no code signing, no Apple Developer account. Start the server, `npx expo start`, scan the QR. The API base URL resolves itself: `EXPO_PUBLIC_API_URL` is `localhost`, which on a phone means the *phone*, so `lib/api/client.ts` swaps in the host Metro already reached the device on (loopback URLs only — a real staging/prod URL passes through). This stops working at **Phase 7 (billing)**, which needs a real dev build. Some things only exist on device: haptics do nothing in the simulator.

---

## 1. What we're building

**Meroa** is a relationship-first AI companion. The user talks to it like a familiar
friend, and Meroa quietly turns real intentions into action. It has three parts:

| Part      | What it does                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| **Chat**  | Natural conversation, everyday help, recommendations, accountability, and app control by plain language.       |
| **Tasks** | Concrete near-term actions: checkboxes, checklists, counters, timers, meters, recurring items.                 |
| **Tools** | Persistent trackers/dashboards (workouts, savings, study, habits, applications…) that hold long-term progress. |

**The MVP proves exactly one loop — nothing more:**

> Talk naturally → Meroa creates structure → progress gets recorded once → the same
> record shows up everywhere (Chat, Tasks, Tools) → support gets more personal over time.

Meroa is **not** a universal assistant and **not** a no-code app builder. If a feature
doesn't deepen that loop, it does not belong in the MVP (see §11).

**MVP is done when:** a new user can meet Meroa, continue the same relationship in the
app, create a task through conversation, create at least one useful custom tool, report
progress naturally, see the task _and_ tool update correctly, and come back because
Meroa remembers both the person and the progress.

---

## 2. Golden rules (non-negotiable)

These apply in every phase. If a task conflicts with one of these, stop and flag it.

**Personality & conversation**

- Friend mode never disappears. Productivity is something the relationship _enables_, not the reason Meroa talks.
- Match the user's length, formality, humor, and directness — don't parrot their slang until Meroa feels fake, and don't turn every message into a lecture + a question.
- Ask before turning an uncertain thought into a tracked task. Don't treat every complaint as a productivity opportunity.
- **Always clearly identified as AI.** Never imply a human is secretly texting. This holds from the very first message, in-app and over text.

**Data integrity (the heart of the loop)**

- **Store each real-world action once; render it everywhere.** Chat, Tasks, and Tools are _views_ of the same record, never separate copies.
- **Never invent missing numbers** to fill a tool. If a value is unclear, ask a short clarifying question.
- Low-confidence extractions must **ask for confirmation** before writing.
- Every write must be **reversible** ("undo that"). Past records survive tool-layout changes.

**Safety & trust**

- Treat health, financial, and emotional information as **sensitive** — even when typed manually.
- Do **not** encourage dependence, exclusivity, possessiveness, or replacing real relationships.
- Meroa is **not** a therapist, doctor, financial adviser, or emergency service, and must not claim to be. No unsupported medical/financial claims.
- Don't reinforce harmful self-judgment just to match the user's tone.
- Users can see, correct, delete, or mark memories sensitive, and say "don't bring this up unless I do."

**Money & privacy**

- Premium uses **platform billing only** (Apple IAP / Google Play Billing). Entitlements are verified **server-side**; never trust a client claim.
- **Hard paywall, not freemium**: new users get a 7-day free trial with full access; without converting to paid, access to every feature is blocked — but no data is ever deleted, so subscribing later picks back up exactly where they left off. There is no persistent limited free tier.
- Ship quiet hours, proactive-message limits, opt-out, data export, and account deletion as real features, not afterthoughts.

---

## 3. Tech stack & version policy

Target the **current stable Expo SDK**, built fresh — not the reference zip's versions.

**Scaffold and pin, don't hand-write versions:**

- Create the app with `npx create-expo-app@latest` (TypeScript template). Whatever SDK it scaffolds is the target.
- Install **every** Expo/React-Native package with `npx expo install <pkg>` — this resolves the SDK-compatible version matrix. Do **not** `npm install` these directly.
- After install, pin exact versions in `package.json` and commit the lockfile.

**As of this writing (July 2026), that lands:** Expo **SDK 57**, React Native **0.86**, React **19.2**, New Architecture on by default, Hermes V1 default. _Verify at scaffold time — SDKs move ~3–4×/year._

| Layer            | Choice                                    | Notes                                                                                                                                                            |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile app       | Expo + React Native + TypeScript (strict) | One codebase, iOS + Android.                                                                                                                                     |
| Navigation       | Expo Router                               | File-based tabs/stack/deep links. **Import paths changed when Router forked from React Navigation (SDK 56) — use the current API, not the reference's imports.** |
| Builds/testing   | EAS Build + EAS Submit, dev clients       | Use **development builds** early — Expo Go can't run all native modules (blur, haptics, billing, notifications).                                                 |
| Backend          | TypeScript API                            | Owns accounts, conversations, AI actions, tasks, tools, reminders, entitlements.                                                                                 |
| Hosting/ops      | Railway (Docker), GitHub Actions CI, Sentry | Server is deployed and live on Railway (Dockerfile-based); CI runs typecheck+tests on push/PR (`.github/workflows/ci.yml`); Sentry captures unhandled + guarded errors; hand-rolled per-user rate limiting on message/task/goal creation; tuned Postgres connection pool. Branch protection on `main` deliberately deferred — solo rapid-iteration phase, revisit if a collaborator joins or a stable release nears. |
| Database         | PostgreSQL (Supabase or equivalent)       | Users, messages, tasks, tool definitions, progress, memories, entitlements.                                                                                      |
| AI               | Hosted model API, **server-side only**    | Plans replies, extracts structured updates, chooses from an **allow-list** of actions.                                                                           |
| Notifications    | Expo Notifications                        | Reminders, follow-ups, conversation alerts.                                                                                                                      |
| Billing          | Apple IAP + Google Play Billing           | Purchase, restore, renewal, expiry, cancel, server entitlement check.                                                                                            |
| Pre-install text | Messaging provider (SMS)                  | Limited onboarding + re-engagement only. Regulated (A2P/10DLC in US) — later phase.                                                                              |

**Must be server-side, never in the app bundle:** model API keys, AI action execution, billing/entitlement verification, and any secret. The client proposes; the server decides and persists.

**Known gotcha to carry forward:** on New-Arch + Hermes V1, importing `react-native-reanimated` can raise Android memory ~25–30% even if unused. Enable _worklets bundle mode_ to mitigate. The reference relies on reanimated, so budget for this.

---

## 4. Architecture in one picture

```
        ┌───────────────────────── Expo app (iOS + Android) ─────────────────────────┐
        │  Chat tab   Tasks tab   Tools tab   You tab                                │
        │  UI state (light store)  +  server-state cache (query layer)               │
        └──────────────▲───────────────────────────────────────────────▲────────────┘
                       │ HTTPS (auth'd)                                  │ push
        ┌──────────────┴──────────── TypeScript API ─────────────────────┴───────────┐
        │  Auth/phone-linking · Chat orchestration · AI action layer (allow-listed,   │
        │  validated, confidence-gated) · Tasks · Tools · Reminders · Entitlements    │
        └──────────────▲───────────────────▲───────────────────▲────────────────────┘
                       │                    │                   │
                 PostgreSQL          Hosted model API      Store billing APIs
              (single source        (server-side keys)     (Apple / Google)
               of truth)
                       ▲
                Messaging provider (pre-install SMS funnel — optional/later)
```

The **AI action layer** is the spine of the product loop: the model proposes structured
actions (`create_task`, `complete_task`, `log_goal_entry`, `edit_goal`, …) against a
constrained schema; the server validates them, gates low-confidence writes behind a
confirmation, applies them to the single record, and lets every view reflect the change.

**A chat turn runs two model passes, and only two** — see **`docs/chat-architecture.md`**,
which is required reading before touching `server/src/lib/ai/`:

```
  user message
      │
      ├─ ACT pass    — has tools, thinking on, decides and acts
      │                 (or calls no_action with a reason + intent)
      │
      ├─ every call succeeded?  ──YES──►  emit the cards. SAY NOTHING.
      │                                    (the card IS the confirmation)
      │                          ──NO───►  NARRATE pass — no tools, streams the reply
      │                                    (a question, a failure, or conversation)
      │
      └─ guards: false claim · concealment · fabricated figure · tool-call leak
                 (at most one correction per turn, all grounded in server state)
```

Three principles carry the whole design, and all three were learned the hard way:

- **A prompt is a suggestion; a guarantee lives in code.** Every prompt rule added to fix
  a correctness bug caused a new failure elsewhere. Every structural fix held. Prefer:
  delete the thing that spoke → fix the context that's lying → make the server refuse.
- **The card is the confirmation.** A successful action turn writes no prose at all. That
  deletes the lie surface rather than policing it — false claims, concealment and invented
  totals all lived in the sentence *about* an action that had already succeeded.
- **Never invent a number.** Every figure is computed in SQL and *quoted* by the model.
  Anything else is a bug, and there is an output-boundary guard that catches it.

---

## 5. Design system (rebuild from scratch to match the reference look)

The reference zip is a **look-and-feel spec**, not code to reuse (see §9). Rebuild these
tokens and components fresh on the current SDK. Dark-first, sleek near-black with blue
accents; chat borrows iMessage familiarity.

**Color tokens**

```
accent blue      #0A84FF     blue-deep   #2563EB    blue-light  #5AB0FF
gradient (btn/me bubble)     #1E8BFF → #0A6DF0
text             #F5F7FA     dim         #8E949E     faint      #5B6068
bg               #030507     surface     #111318     card       #191C22    card-2  #1F232B
ai bubble        #1C1F25
border           rgba(255,255,255,0.06)   border-strong  rgba(255,255,255,0.10)
success          #30D158     danger      #FF453A
```

**Shape & type**

- Radii: bubble 20 (tightened tail corner 6), card 18, section 16, button/input 18/14, icon-chip 10, checkbox & ring 999 (pill).
- Type: screen title 16/700 · big header 26–28/700 (−0.5 tracking) · eyebrow 11/700 (+1.2 tracking, uppercase) · body 15 · meta 12–14 · bubble 15 / 20 line-height.
- Tab bar: absolute, translucent (iOS blur ~40, dark tint), active = blue, inactive = dim, label 10.5/600.

**Chat rules (iMessage feel)**

- User bubbles: blue gradient, right-aligned, subtle blue glow, bottom-right corner tightened. AI bubbles: flat `#1C1F25`, left-aligned, bottom-left corner tightened.
- `maxWidth ~78%`, compact vertical grouping, rounded composer. (The reference's attach + mic↔send swap was dropped in Phase 8: they were dead-end controls — no voice or attachment feature exists server-side — and Apple rejects on those. The composer is now text + a send button that appears only when there's text.)

**Components to rebuild:** `MeroaMark` (gradient "M" logo + 3 chat dots), `Icon` (stroke SVG set: chat, tasks, tools, you, plus, send, mic, paperclip, ellipsis, check, droplet, clock, briefcase, dumbbell, wallet, book, chevron, bell, moon, lock, crown, logout, sparkle, flame), `Bubble`, `Progress` (gradient bar), `Ring` (SVG meter), `TaskCard`, `ToolCard`, `Row`, `PrimaryButton`, and the blurred tab bar.

**UX principles:** one screen does one main job; use bottom sheets for quick create/edit/log; subtle haptics + short animations on send/complete/update (satisfying, not distracting). Light theme is later, via the same semantic tokens.

---

## 6. Project structure & conventions

Proposed layout (adjust as the app grows):

```
meroa/
  app/                      # Expo Router routes
    (tabs)/                 #   index(Chat) · tasks · tools · you
    _layout.tsx
  components/               # Bubble, TaskCard, ToolCard, Ring, Icon, MeroaMark, sheets…
  features/                 # chat/ tasks/ tools/ memory/ billing/ — feature-scoped logic
  lib/                      # api client, query hooks, store, formatting, haptics
  constants/                # theme tokens, config
  server/                   # TypeScript API (or a sibling repo) — AI actions, entitlements
  docs/phases/              # the phase specs
  CLAUDE.md
```

**Conventions**

- TypeScript `strict: true`. Path alias `@/*` → project root.
- Keep secrets out of the app; read config via `expo-constants` / EAS env, secrets server-side.
- Components are presentational; data/AI logic lives in `features/` + `server/`.
- Every schema change ships with a migration. Never a destructive migration that drops historical progress.
- Small, reviewable commits scoped to one phase task.

---

## 7. Commands

```bash
# scaffold (once) — the SDK it picks is the target
npx create-expo-app@latest meroa

# add packages (always via expo install for RN/Expo libs)
npx expo install expo-router react-native-svg expo-haptics expo-blur \
  expo-linear-gradient react-native-reanimated react-native-gesture-handler

# run
npx expo start                 # dev server (use a dev build, not just Expo Go)
npx expo run:ios               # local iOS build
npx expo run:android           # local Android build

# quality gates (wire these up in Phase 0)
npx tsc --noEmit               # typecheck
npm run lint                   # eslint
npx expo-doctor                # dependency/version sanity

# ship
eas build --profile development --platform all
eas build --profile production  --platform all
eas submit
```

---

## 8. The reference app (`meroa-expo.zip`)

**Take:** visual language, color tokens, chat styling, component _shapes_, tab structure, the four-tab IA, the seed conversation that shows the friend→task loop.

**Ignore:** every version number (it's SDK 52 / Expo Router 4 / RN 0.76 — outdated), the mock/seed data, and any import paths (Expo Router's imports changed in a later SDK). Rebuild on the current SDK; use the reference only to check "does it look right."

---

## 9. Build roadmap — one phase at a time

Work phases **in order**. Each has a self-contained spec in `docs/phases/` with tasks and
an explicit **Definition of Done (DoD)**. Do not start a phase until the previous phase's
DoD is met. When working a phase, load that phase's file alongside this one.

| #   | Phase                                                                                | File                                                  | Status |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------ |
| 0   | Foundation & design system (fresh scaffold, tokens, components, static tabs). App icon/splash/Android adaptive-icon assets were left as `create-expo-app` scaffold defaults through Phases 1–7 (never actually replaced) — fixed 2026-07-19 to match `MeroaMark` | `docs/phases/phase-0-foundation-design-system.md`     | ☑      |
| 1   | Backend, accounts & continuity (API, DB, phone-linking, text→app handoff)            | `docs/phases/phase-1-backend-accounts-continuity.md`  | ☑      |
| 2   | Live chat (model API, streaming, history, limits, AI disclosure)                     | `docs/phases/phase-2-live-chat.md`                    | ☑      |
| 3   | Tasks (all types, chat + UI creation, recurring, reminders, missed-task recovery)    | `docs/phases/phase-3-tasks.md`                        | ☑      |
| 4   | ~~Tools~~ — superseded by the Goals redesign (see `docs/goals-redesign-plan.md`); Tools tab and its generic field/template builder scrapped in favor of Goals | `docs/phases/phase-4-tools.md`                        | ☑ (superseded) |
| 5   | **The connected loop** (one record ↔ Chat/Tasks/Goals, undo, confirmation gating) — one stored record renders everywhere, all four goal types, task↔goal linking, undo, and history-aware replies; DoD protocol run passed (found + fixed 3 live bugs). Provider decision resolved in Phase 6: **deepseek-v4-flash confirmed as production** | `docs/phases/phase-5-connected-loop.md`               | ☑      |
| 6   | Personalization, memory & trust (vibe, adaptive style, memory controls, quiet hours) — **read `docs/chat-architecture.md` first.** Presets change *how* the reply pass talks; memories are stored data **injected into context and quoted**, never model recall — so they follow the same rule as every number in the app. Safety boundaries verified via a 9-scenario adversarial red-team (`docs/safety-redteam-2026-07-15.md`, all held) | `docs/phases/phase-6-personalization-memory-trust.md` | ☑      |
| 7   | Free & Premium — **hard paywall with a 7-day free trial** (not freemium): RevenueCat chosen, $11.99/mo; trial and paid both get full access, a lapsed/never-started user gets none (nothing deleted). Signup flow is now onboarding (motivational questionnaire, supersedes Phase 6's standalone vibe-pick) → paywall → tabs, verified live end-to-end in the simulator. Server+client+paywall implemented and curl/battery-verified. **Blocked**: purchase/restore/cross-device DoD items, plus the 7-day trial itself, need the human RevenueCat + Apple App Store Connect sandbox/dashboard setup (including the trial introductory-offer config) — see `docs/phases/phase-7-premium-billing.md` | `docs/phases/phase-7-premium-billing.md`              | ☐ (blocked on dashboard) |
| 8   | Release readiness (notifications, deep links, privacy, deletion, store submission). Server production infra (Docker, GitHub Actions CI, Sentry, rate limiting, DB pool tuning) is already live on Railway — see §3 — so this phase is scoped to the mobile app + store submission side, not backend hosting. Its purchase/restore verification task still depends on Phase 7's blocked item above | `docs/phases/phase-8-release-readiness.md`            | ☐      |
| 9   | _(Optional)_ Pre-install text funnel & re-engagement (SMS provider, compliance)      | `docs/phases/phase-9-text-funnel-reengagement.md`     | ☐      |

Phase 5 is the MVP's reason to exist — Phases 3 and 4 are prerequisites for it, not
ends in themselves. Phase 9 completes the discovery funnel but is not required to
validate the core product loop; sequence it after the in-app loop works.

---

## 10. Do NOT build before the loop works

- Bank connections or money movement.
- Medical diagnosis or treatment features.
- Live GPS run tracking, Apple Watch, HealthKit / Health Connect.
- Full email/calendar management, group chat, or a plugin marketplace.
- A pile of novelty integrations that don't deepen the core loop.

Meroa can build trackers, logs, checklists, planners, dashboards, journals, and
collections from supported components — it does **not** generate arbitrary executable
apps inside the app.

---

## 11. References to re-check before each release

Store policies and required API levels change — re-check immediately before every submit:

- Expo development builds, EAS Build, EAS Submit.
- Apple: App Review Guidelines, App Privacy, account deletion, In-App Purchase.
- Google Play: Data safety, account deletion (incl. **web** deletion path required when accounts exist), billing, target API level.
