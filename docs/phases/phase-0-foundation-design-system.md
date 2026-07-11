# Phase 0 — Foundation & Design System

**Status:** ☑ Done
**Goal:** A fresh Expo app on the current stable SDK that reproduces the reference's
look and feel across all four tabs — static/mock data only, no backend yet.
**Depends on:** nothing.

Read `CLAUDE.md` §3 (version policy), §5 (design system), §8 (reference app) first.

## In scope
- Scaffold, theme tokens, core component library, four static tabs, quality gates, a dev build running on real iOS + Android.

## Out of scope
- Any network calls, auth, AI, persistence, notifications, billing. All screens use in-memory mock data.

## Tasks
- [x] `npx create-expo-app@latest meroa` (TypeScript). Record the SDK/RN/React versions it picks in the README.
- [x] Configure `app.json`: name/slug Meroa, `userInterfaceStyle: "dark"`, portrait, scheme `meroa`, iOS/Android bundle IDs, Expo Router + font plugins, typed routes.
- [x] TypeScript `strict`, path alias `@/*`. Add ESLint + Prettier. Wire `tsc --noEmit`, lint, and `expo-doctor` as scripts.
- [x] Add UI deps via `expo install`: react-native-svg, expo-haptics, expo-blur, expo-linear-gradient, reanimated, gesture-handler, safe-area-context, screens. Enable reanimated's babel plugin.
  - Note: attempted **worklets bundle mode** per CLAUDE.md §3, but `getBundleModeMetroConfig` redirects *all* `react-native` imports app-wide to a limited shim — breaks the main app bundle (confirmed: `Pressable` etc. become unresolvable). Reverted; this optimization needs a separate worklets-runtime bundle target, not our main Metro config. Left as a follow-up, not blocking — it's an Android-only memory mitigation.
- [x] Create `constants/theme.ts` with the token set from CLAUDE.md §5 (colors, radii, type scale). Set up a dark navigation theme.
- [x] Rebuild components: `MeroaMark`, `Icon` (full stroke-SVG set), `Bubble`, `Progress`, `Ring`, `TaskCard`, `ToolCard`, `Row`, `PrimaryButton`.
- [x] Rebuild the blurred bottom tab bar (Chat / Tasks / Tools / You) using the current Expo Router API — **do not copy the reference's import paths**.
- [x] Build the four screens with mock data to match the reference: Chat (header with logo + "listening" status, message list, composer with attach + mic↔send), Tasks (TODAY header + progress ring + toggleable task list), Tools (tool cards with rings + progress), You (profile hero + settings sections).
- [x] Add haptics on send/toggle, tap-scale feedback on buttons/rows, and animated ring/progress transitions. Confirmed working on iOS (focus/type/send, checkbox toggle, tab switch all functional — on-screen keyboard visibility in the simulator is a Simulator hardware-keyboard-passthrough setting, not an app issue).
- [x] Run the app on iOS via a local dev build (`npx expo run:ios`) — verified on iPhone 17 Pro simulator. Android not yet set up (deferred per CLAUDE.md — its toolchain comes later).

## Definition of Done
- App launches on the iOS simulator/device with no red screens (Android verified later, once its toolchain is set up).
- All four tabs render and match the reference visually (spot-check against the zip screenshots).
- Chat composer sends a mock message with haptic feedback; task checkboxes toggle; rings/bars reflect mock values.
- `tsc --noEmit`, lint, and `expo-doctor` all pass clean.

## Guardrails
- Rebuild, don't paste. The reference is SDK 52; its versions and imports are stale.
- No secrets, no network, no placeholder screens or dead buttons that pretend to work.
