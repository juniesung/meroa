# Meroa

A relationship-first AI companion, built with Expo + React Native. See `CLAUDE.md`
for the project constitution and `docs/phases/` for the phased build plan.

## Versions

Scaffolded with `npx create-expo-app@latest` (TypeScript template) on:

- Expo SDK 57.0.6
- React Native 0.86.0
- React 19.2.3
- TypeScript ~6.0.3
- New Architecture on, Hermes V1 default

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

   Or build locally to the simulator:

   ```bash
   npx expo run:ios
   npx expo run:android
   ```

## Quality gates

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint
npm run doctor       # expo-doctor
```

## Project structure

- `src/app/` — Expo Router routes (file-based)
- `src/components/` — presentational UI components
- `src/constants/theme.ts` — design tokens (colors, radii, type scale)
- `docs/phases/` — per-phase specs; work one phase at a time per `CLAUDE.md`

## Learn more

- [Expo documentation](https://docs.expo.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/)
