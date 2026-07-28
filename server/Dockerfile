# Runs tsx directly against the TypeScript source in production, same as
# `npm start` locally — tsx/typescript are devDependencies, and there's no
# compiled-JS build step (tsconfig.json has noEmit: true). Trades a larger
# image (full node_modules, including devDependencies) for zero new behavior
# to validate on a first production deploy. Revisit as an optimization once
# the deploy is stable.
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
EXPOSE 8787
# Apply pending migrations, THEN start the server. drizzle tracks applied
# migrations in __drizzle_migrations, so re-running on a plain restart is a
# fast no-op; a genuinely new migration is applied before traffic. If a
# migration fails, the server never starts and the deploy fails loudly — the
# right behavior. NOTE: this runs per-container, so it's correct for a SINGLE
# replica (the current setup). If you ever scale to 2+ replicas, move this to a
# run-once Railway pre-deploy command so replicas don't race to migrate.
CMD ["sh", "-c", "npm run db:migrate && npx tsx src/index.ts"]
