# Achievements redesign — personalized, behavior-derived achievements

## Context

The You tab has a solid but thin achievement skeleton: 5 **global** families
(tasks completed, streak, active days, goals started/finished), each a code-
defined tiered badge earned from a real SQL count, with progress-to-next already
computed and stored append-only (`achievements` table: key+tier). It works, but
nothing is tied to the user's *specific* goals, there are no personal records,
and there's no rich "what am I close to?" surface.

Goal (founder call, 2026-07-28): give users a real reason to keep completing
tasks/goals and coming back — a **personalized** achievement system that knows
how long they've kept up, how consistent they've been, and how long their
streaks are, and surfaces **custom achievements** (achieved + a few upcoming
they're progressing on) on the You tab.

**Research grounding** (Trophy cross-app data, Duolingo, Strava, goal-gradient
literature, + our founder-reviewed retention-ethics memory):
- Retention rises **monotonically with achievement difficulty** (32% easy → 74%
  hard) → layered difficulty, not uniform-easy.
- The **first achievement is decisive** (day-0 unlock → 57% retention; none by
  day 7 → 8.5%) → a genuinely easy day-0 badge.
- Split **Personal Records** (self-referential bests) from **milestone Awards**.
- **Multiple tracks for multiple motivations** (Strava: speed vs consistency).
- **Show progress toward the next one** (goal-gradient; the last ~10% is the
  strongest pull) → the "In progress" section is the highest-leverage piece.
- Guardrail (retention-ethics memory): **earned transitions, framed as the
  user's own growth**; no guilt/FOMO/loss-aversion, no "days with Meroa".

**Confirmed decisions:** deterministic per-goal engine + Meroa-voiced
celebration (never LLM-invented criteria — keeps every number groundable); a
dedicated Achievements screen; v1 includes all four dimensions (per-goal
streaks/progress, consistency & tenure, personal records, richer global tiers +
a day-0 badge).

The whole design stays **deterministic and groundable** — the "custom" feeling
comes from *instantiating* code-defined families per goal with the user's real
names and numbers, not from an LLM inventing achievements. This is the only
approach consistent with "never invent a number" (CLAUDE.md §2/§4).

---

## What exists to reuse

- `server/src/lib/achievements/catalog.ts` — pure family/tier catalog +
  `earnedThresholds` / `nextTier` (the "earned?" and "how close?" logic).
- `evaluate.ts` — `computeAchievementCounts`, `evaluateAchievements(userId, tz,
  db, {silent})` (inserts newly-earned tiers, returns `NewlyEarned[]`),
  `mostSignificant`, `markAnnounced`; count helpers all count **done tasks /
  distinct days**, never raw records (the correct convention).
- `copy.ts` `congratsLine(key, tier)` — the Meroa-voiced celebration.
- Announce path: `routes/messages.ts` (chat turn → evaluate → congrats +
  markAnnounced); silent pre-stamp on `routes/profile.ts` (GET /profile/overview).
- `achievements` table (`userId, key(text), tier(int), earnedAt, announcedAt`),
  append-only, unique (user,key,tier) — **key is free text, so new namespaced
  keys need no migration.**
- Grounded measures already available: `buildGoalCardSummaries` (per-goal
  progress + streak), `buildGoalConsistency` (dueCount/doneCount per day →
  consistency %), `buildTaskCompletionHistory` (per-series counts),
  `AchievementBadge` client component (earned/started/untouched states +
  progress bar).

---

## Design

### 1. The engine: a per-user *instantiated* catalog

Replace the single static `ACHIEVEMENT_CATALOG` with a function
`buildUserCatalog(userId, tz)` that returns the full set of families **for this
user**: the static globals + one family per relevant goal + personal-record +
consistency/tenure families. Each family carries:
- `key` (namespaced, stable): `global:tasks_completed`, `goal_streak:<goalId>`,
  `goal_progress:<goalId>`, `goal_tenure:<goalId>`, `consistency:habits_month`,
  `pr:tasks_in_day`, … (existing global keys stay **unprefixed** for back-compat
  so already-earned rows still resolve).
- `title`/`unit` with the real goal name woven in (`"Meditation — day streak"`).
- `icon` (server-authored — see client change).
- `tiers` (thresholds + labels), difficulty-layered.
- a `measure`: the current real value, computed in SQL from the reused helpers.

Families in v1:
- **Global (richer):** tasks_completed (add a `1` day-0 tier + more tiers),
  streak, active_days, goals_started, goals_finished.
- **Per-goal streaks/progress:** for each active goal — a habit goal gets
  `goal_streak:<id>` (7/30/100/365 of *that* habit); a savings goal gets
  `goal_progress:<id>` (25/50/75/100% funded); a milestone goal gets a
  stage-advance tier. Measure = `buildGoalCardSummaries`.
- **Tenure:** `goal_tenure:<id>` — months the goal has stayed active with real
  activity (1/3/6/12mo). "Kept <goal> going 3 months."
- **Consistency:** `consistency:habits_month` — % of due habit check-ins kept
  this month (via `buildGoalConsistency`); tiers e.g. 80/95/100% with a minimum
  volume so it's a real earned transition, not a fluke.
- **Personal records** (self-referential; see 3).

Difficulty is layered per research: an easy first tier in the cheap families
(day-0), escalating to genuinely hard ones (365-day streak, 250 tasks).

### 2. Evaluation & announcement

`evaluateAchievements` iterates `buildUserCatalog`, computes each measure,
inserts newly-earned tiers (unique constraint makes it idempotent), returns
`NewlyEarned` enriched with display info (title/goal name/icon) so the congrats
line can name it. Meroa celebrates in her voice (`congratsLine` extended to take
the instantiated label, e.g. "100 days of Meditation — that's a real practice
now"). Keep the existing announce-on-chat-turn + silent-pre-stamp-on-profile
paths; **additionally** fire `evaluateAchievements` (fire-and-forget) from the
task/goal mutation routes (beside the WS1 `emitReaction` hooks) so a badge earned
from the Tasks/Goals tab is caught promptly and announced on the next turn.

### 3. Personal records

Compute on the fly (no new table for v1): `most tasks in a day`, `longest streak
ever` (= `buildGoalConsistency.longest`), `best week` (max weekly completions).
Surfaced as their own "Personal records" cards on the Achievements screen (value
+ when set). Celebrate-on-beat (Meroa notices a new PR) is a fast follow — it
needs the prior best stored to detect the beat; deferred from v1.

### 4. The Achievements screen (client)

New `src/app/achievements.tsx`, reached from the You tab:
- **In progress** (top): the nearest N (~5) not-yet-earned tiers across all
  families, ranked by `progressToNext` desc (only ones with real progress), each
  a goal-gradient progress bar. This is the "upcoming ones you're making
  progress on."
- **Earned** (scrollable gallery): every earned badge, newest first, using the
  existing `AchievementBadge`.
- **Personal records**: the self-referential bests.
The **You tab** keeps a compact preview: a few most-recent earned + the single
closest upcoming, with a "See all →" into the screen.

New endpoint `GET /achievements` returns `{ inProgress[], earned[], records[] }`
(the full per-user set can be large; the You-tab keeps using the trimmed
`profile/overview` achievements or a capped slice). Server-authored views so the
client renders generically.

### 5. Client type change (enables dynamic keys)

`ApiAchievementView.key` becomes a plain `string` (not the fixed union), and the
view gains `icon` (+ optional `category: 'global'|'goal'|'record'` for grouping).
`AchievementBadge` reads `badge.icon` from the server instead of the client-side
`FAMILY[key]` icon map (that map is deleted). Everything else about the badge
(earned/started/progress) is unchanged.

---

## Critical files

- Server: `lib/achievements/catalog.ts` (→ `buildUserCatalog` + per-goal/PR/
  consistency families), `evaluate.ts` (instantiated evaluation + enriched
  `NewlyEarned`), `copy.ts` (label-aware congrats), `lib/profile/overview.ts`
  (trimmed You-tab slice), new `routes/achievements.ts` (`GET /achievements`),
  mutation-route hooks in `routes/tasks.ts`/`goals.ts` (fire-and-forget evaluate).
- Client: new `app/achievements.tsx`, `components/AchievementBadge.tsx` (server
  icon), `app/(tabs)/you.tsx` (compact preview + "See all"), `lib/api/types.ts`
  + `lib/api/client.ts` (`ApiAchievementView.key: string` + `icon`; `getAchievements`).
- No DB migration (key is text; new namespaced keys + unprefixed legacy keys
  coexist). No destructive change — earned rows are permanent.

## Verification

- Pure unit tests for the new measures/tier logic (per-goal streak tiers,
  tenure-months, consistency %, PR maxes) — deterministic, no DB.
- Dev-token SSE + DB battery: seed a habit goal, complete its check-in across a
  streak → `goal_streak:<id>` tier earns once (re-completion never re-earns);
  a savings goal crossing 50% earns `goal_progress:<id>:50`; tenure computes from
  `createdAt`; consistency reflects due-vs-done; the day-0 badge unlocks on the
  first completion. Confirm `GET /achievements` returns sensible
  inProgress/earned/records and the "In progress" ranking is nearest-first.
- Re-check the counting convention (this plan's whole premise): every measure
  counts done tasks/instances or a groundable summary value, never raw
  completion events — mirror the audit that fixed the weekly recap.
- tsc (both) + lint + server tests green. Visual pass on device for the screen.

## Phasing (each shippable)

1. Engine: `buildUserCatalog` + global-tier enrichment + day-0 badge + evaluation
   over the instantiated catalog (+ unit tests). Existing UI keeps working.
2. Per-goal families (streak/progress/tenure) + consistency + enriched congrats.
3. `GET /achievements` + the dedicated Achievements screen + You-tab preview +
   the server-icon client change.
4. Personal records (compute-on-the-fly display); celebrate-on-beat as a follow.
