# App Store listing — Meroa (ASO-optimized draft)

> Draft copy + ASO strategy for the App Store Connect listing. Character counts
> are exact; verify in App Store Connect before saving (it enforces the limits).
> ASO mechanics below are from 2026 App Store research — see Sources at the end.

---

## 0. The ASO rules this draft follows

- **Only 3 fields are indexed for search:** app name (30), subtitle (30), keyword
  field (100). **The description is NOT indexed by Apple** — so it's written for
  *conversion*, not keywords.
- **Apple de-duplicates:** a word already in the name or subtitle is wasted in
  the keyword field. Every indexed word appears **once**, total.
- **Keyword field format:** single words, comma-separated, **no spaces after
  commas**, **singular** (plurals auto-index), no special characters. Skip
  auto-indexed filler (`app`, `free`, `best`, `new`, `iphone`).
- **Apple builds phrases** from individual words across all 3 fields — so the
  keyword field holds *component* words that combine with the title/subtitle
  (e.g. keyword `partner` + title `Accountability` → "accountability partner").
- **NEW (2025): screenshot captions are OCR-indexed.** The first 3 screenshots'
  caption text is now a ranking signal — so captions carry keywords too (§6).
- **Target winnable long-tail, not head terms.** A new app won't rank for "habit
  tracker" on day one; "ai accountability coach" / "goal buddy" are winnable.

---

## 1. Category  ⚠️ strategic decision

- **Primary: Productivity.** Highest commercial intent for the core value (turn
  talk → tracked tasks/goals/accountability) and where paying "coach/accountability"
  searchers live. Crowded, but the AI-companion + accountability angle is
  differentiated.
- **Secondary: Health & Fitness** (habits, self-improvement, coaching) — or
  **Lifestyle** if you want a less-saturated browse field.
- Deliberately **not** Entertainment/Social — that's the "AI girlfriend" bucket,
  wrong intent and worse monetization for a productivity companion.

---

## 2. App Name (30 max)

**Primary → `Meroa: AI Accountability Coach`**  *(30/30)*
Brand + the strongest winnable intent phrase. Indexes: `ai`, `accountability`, `coach`.

Alternatives:
- `Meroa: AI Habit & Goal Coach` *(28)* — trades "accountability" for higher-volume `habit`/`goal` in the title.
- `Meroa: Accountability Partner` *(29)* — leans companion over coach.

---

## 3. Subtitle (30 max)

**Primary → `Habit & goal buddy that texts`**  *(29/30)*
New indexed words (no title overlap): `habit`, `goal`, `buddy`, `texts`. Also
sells the differentiator — it reaches out first.

Alternatives:
- `Habits, goals & follow-through` *(30)* — benefit-led; indexes `habit`, `goal`.
- `Your AI habit & goal tracker` *(27)* — adds `tracker`, but repeats `ai` from the title (wasteful) — only use with the `Meroa: Accountability Partner` name.

---

## 4. Keyword field (100 max, no spaces)

Assumes the **primary** name + subtitle above (so it excludes: ai, accountability,
coach, habit, goal, buddy, texts).

```
partner,companion,friend,discipline,routine,motivation,planner,task,reminder,streak,tracker,mentor
```
*(98/100)*

Phrases this lets Apple build with the title/subtitle: *accountability partner ·
ai companion · ai friend · ai mentor · habit tracker · habit routine · habit
streak · goal planner · goal tracker · daily reminder · task …*

> ⚠️ **Validate volumes before launch.** I picked these for strategic coverage, not
> measured search volume (I can't pull live data). Run them through App Store
> Connect's search suggestions or a tool (AppTweak / Sensor Tower / Astro) and
> swap the lowest-volume words. ASO is iterative — revisit ~2 weeks post-launch
> using the impressions/tap data.

---

## 5. Description (4000 max — NOT indexed; written to convert)

First ~3 lines show above the "more" fold — they do the work.

```
Meroa is the AI friend who actually holds you to your word.

Tell it what you're trying to do — save for a trip, hit the gym, finally call
your mom — and it quietly turns the conversation into real tasks and goals.
Then it checks in. When you keep pushing something off, it says so. When you
show up, it notices. It's the accountability of a good friend, in your pocket.

WHY IT WORKS
Meroa is built on what actually changes behavior, not vibes:
• Writing goals down makes you 42% more likely to reach them (Matthews, 2015)
• Checking in with someone raises follow-through to 76% vs 43% alone
• Real habits take ~66 days, not 21 — showing up most days is what counts

HOW IT WORKS
1. Talk to it like a friend — no forms, no menus.
2. It turns real intentions into tracked tasks, goals, and habits.
3. It follows up, remembers what matters, and keeps your progress in one place.

WHAT YOU GET
• A companion that texts first — a nudge when you'd otherwise drift
• Tasks, checklists, counters, timers, and recurring reminders
• Goals for saving, habits, measurements, and milestones — all in one view
• A memory that actually remembers you (and that you control)
• A voice you set: slide from warm and gentle to blunt and a little edgy
• Streaks and earned badges from your real activity — never busywork

BUILT ON TRUST
• Your data is yours. See, correct, or delete anything, any time.
• Sensitive topics stay sensitive. Quiet hours and message limits are real settings.
• Meroa is always clearly an AI, and it won't pretend to be a therapist or doctor.

Meroa Plus — start with a 7-day free trial, then $11.99/month for full access.
• Payment is charged to your Apple ID at confirmation of purchase.
• Auto-renews unless turned off at least 24 hours before the period ends.
• Manage or cancel anytime in your App Store account settings.
• Terms: https://meroa.app/terms · Privacy: https://meroa.app/privacy
```

> ⚠️ Confirm the **Terms/Privacy URLs**, price, and trial length match the live
> RevenueCat/App Store Connect config. Apple guideline 3.1.2 requires the
> subscription terms block above — keep it.

---

## 6. Screenshot captions (OCR-indexed — carry keywords + benefit)

First 3 matter most for ranking. Keep them short and legible.

1. **"Your AI accountability partner"** — indexes *accountability partner*
2. **"Turn a text into a tracked habit"** — *tracked habit*
3. **"Goals that actually move"** — *goals*
4. "It checks in when you slip"
5. "Remembers what matters to you"
6. "Warm or edgy — you set the tone"

(Screenshots themselves need the running build — captured during #1/#5.)

---

## 7. Promotional text (170 max — editable anytime, no review)

```
Meet the AI friend who holds you to your word: turns what you say into real
habits & goals, texts first when you slip, and remembers what matters. 7 days free.
```
*(159/170)* — use this to A/B messages or announce changes without a resubmit.

---

## Sources

- [App Store indexed fields map (2026)](https://appscreenshotstudio.com/tools/app-store-indexed-fields)
- [App Store keyword field guide (2026)](https://www.applaunchflow.com/blog/app-store-keyword-field-guide-2026)
- [ASO title playbook](https://appfollow.io/blog/app-store-optimization-title)
- [Singular vs plural keywords](https://www.apptweak.com/en/aso-blog/do-singular-or-plural-keywords-rank-differently-in-aso)
- [iOS keyword field optimization](https://www.apptweak.com/en/aso-blog/how-to-optimize-your-ios-keyword-field)
- [App category ranking 2026](https://asoworld.com/en/blog/app-category-ranking-factors-2026-how-ai-powered-curation-is-changing-the-game/)
