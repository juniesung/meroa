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

## 1. Category  ✅ decided (2026-07-26)

- **Primary: Productivity.** Highest commercial intent for the core value (turn
  talk → tracked tasks/goals/accountability), best keyword-relevance match for
  "coach / goal / task" searchers, and where the app's identity is clearest.
  Carries the algorithmic weight.
- **Secondary: Health & Fitness.** A reach play, not an identity claim: it's the
  less-saturated shelf of the options AND where Apple's editors run the constant
  "build better habits / self-improvement / new-year" features — the biggest
  single reach lever for an indie app. Habits/goals/follow-through is a legit fit
  for that self-improvement sub-space (Fabulous, Finch — companion apps, not
  fitness apps — both live in Health & Fitness). No health claims are made, so
  the extra Health & Fitness review scrutiny doesn't apply.
- Considered **Lifestyle** for the secondary (cleaner taxonomy fit) but chose
  Health & Fitness for the featuring + lower-saturation reach upside.
- Deliberately **not** Entertainment/Social — that's the "AI girlfriend" bucket,
  wrong intent and worse monetization.

---

## 2. App Name (30 max)  ✅ chosen

**`Meroa: AI Habit & Goal Coach`**  *(28/30)*
Indexes: `ai`, `habit`, `goal`, `coach` — high-volume intent terms in the
strongest field. Frees `accountability` to anchor the subtitle (below).

Alternatives (not chosen):
- `Meroa: AI Accountability Coach` *(30)* — more differentiated, less habit/goal volume.
- `Meroa: Accountability Partner` *(29)* — companion lean.

---

## 3. Subtitle (30 max)

Title already used habit/goal/coach — so the subtitle must add **new** words.
The highest-value one now free is `accountability`; the subtitle is a "premium"
indexed slot, so spend it on the best phrase.

**Primary → `Your accountability partner`**  *(27/30)*
Indexes two high-value terms: `accountability`, `partner`. The "texts first /
reaches out" differentiator is carried by the screenshots + description instead.

Alternatives:
- `The friend who texts you first` *(30)* — distinctive + on-brand, but only indexes `friend`; move `accountability`/`partner` to the keyword field. Choose this if you value the tagline's punch over the search-reach of "accountability partner."
- `Accountability that texts you` *(30)* — splits the difference: indexes `accountability` + hints the hook.

---

## 4. Keyword field (100 max, no spaces)

Deduped against the chosen name (`ai`, `habit`, `goal`, `coach`) and primary
subtitle (`accountability`, `partner`) — so those are **excluded** here.

```
companion,friend,buddy,discipline,routine,motivation,planner,task,reminder,streak,tracker,journal
```
*(97/100)*

Phrases this lets Apple build across all three fields: *ai companion · ai friend ·
accountability buddy · habit tracker · habit routine · habit streak · goal
planner · goal tracker · goal journal · daily reminder · task · self-discipline*.

> If you switch the subtitle to `The friend who texts you first`, add
> `accountability,partner` back here and drop `friend` (it'd be in the subtitle) —
> e.g. `accountability,partner,companion,buddy,discipline,routine,motivation,planner,task,reminder,streak` *(99)*.

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
