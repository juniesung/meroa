# App Store listing — Meroa (ASO-optimized draft)

> Draft copy + ASO strategy for the App Store Connect listing. Character counts
> are exact; verify in App Store Connect before saving (it enforces the limits).
> ASO mechanics below are from 2026 App Store research — see Sources at the end.

---

## 0. The ASO rules this draft follows

- **Apple indexes SIX surfaces for search (2026):** app name (30), subtitle (30),
  keyword field (100), **IAP display names**, **in-app event titles**, and
  **screenshot-caption OCR**. The **description is NOT indexed** — it's written for
  *conversion*, not keywords. §1–6 optimize name/subtitle/keywords/captions; the
  IAP-name + in-app-event surfaces and **cross-locale keyword expansion** (the
  single biggest untapped lever) are in **§8**.
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

**Primary → `Daily accountability partner`**  *(28/30)*
Indexes three high-value terms: `daily`, `accountability`, `partner` (and Apple
builds `daily habit` / `daily goal` by combining with the title). This reclaims
the slot the earlier `Your accountability partner` spent on **`Your`**, which
indexes nothing — a free extra keyword for the same read.

Alternatives:
- `Your accountability partner` *(27)* — warmer, but `Your` is dead weight (indexes nothing). Choose only if the warmth matters more than the extra keyword.
- `The friend who texts you first` *(30)* — distinctive + on-brand, but only indexes `friend`; move `accountability`/`partner` to the keyword field. Choose this if you value the tagline's punch over the search-reach of "accountability partner."
- `Accountability that texts you` *(30)* — splits the difference: indexes `accountability` + hints the hook.

---

## 4. Keyword field (100 max, no spaces)

Deduped against the chosen name (`ai`, `habit`, `goal`, `coach`) and primary
subtitle (`accountability`, `partner`) — so those are **excluded** here.

```
companion,friend,buddy,discipline,routine,motivation,planner,task,reminder,streak,tracker,checklist
```
*(99/100)*

Swapped `journal` → `checklist`: journaling isn't a Meroa feature (so `journal`
was low-relevance and risked matching poorly), while **checklists are a real task
type** — higher relevance, honest match.

Phrases this lets Apple build across all three fields: *ai companion · ai friend ·
accountability buddy · habit tracker · habit routine · habit streak · goal
planner · goal tracker · goal checklist · daily reminder · task · self-discipline*.

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
• Terms: https://meroa-production.up.railway.app/terms · Privacy: https://meroa-production.up.railway.app/privacy
```

> ✅ **URLs fixed (2026-07-26).** Point at the live served pages
> (`server/src/routes/legal.ts`) — both `/terms` and `/privacy` return 200.
> `meroa.app` never resolved. Put the same Privacy URL in App Store Connect's
> dedicated **Privacy Policy URL** field too. Both are editable later, so a custom
> domain can swap in post-launch with no resubmit.
> ⚠️ Still confirm price and trial length match the live RevenueCat / App Store
> Connect config. Apple guideline 3.1.2 requires the subscription-terms block
> above — keep it.

---

## 6. Screenshots (produced 2026-07-26 — dark, device-framed, headline + subtitle)

Captions are OCR-indexed (lower weight), so the first 3 headlines carry keywords.
The produced set, in order:

1. **"Turn goals into daily action"** — *Chat with Meroa and instantly turn intent
   into a real daily habit.* (chat → habit creation) — indexes *goals, daily*
2. **"Know exactly what to do today"** — *Meroa turns your goals into a focused
   daily plan you can actually follow.* (Tasks tab) — indexes *goals, daily, plan*
3. **"Track every goal in one place"** — *From fitness to savings, Meroa keeps your
   goals organized and easy to manage.* (Goals tab) — indexes *track, goal, fitness, savings*
4. **"Stay motivated with streaks & achievements"** — *Celebrate progress, keep
   streaks alive, and build consistency over time.* (You tab) — indexes *streaks, achievements*

> ⛔ **BLOCKER — resolution/aspect.** The exported files are **941×1672**, which is
> too small AND the wrong aspect ratio for the App Store. Apple requires exact
> device dimensions; target **1320×2868 (6.9", iPhone 16 Pro Max)** — one set now
> covers all iPhones. Two fixes needed: (a) render at full resolution (upscaling
> 941px will look soft), and (b) re-compose in the taller/narrower ~0.46 aspect
> (these are ~0.56, too wide) so nothing is cropped or letterboxed.
> Minor polish (optional): the in-app habit reads "Work out everyday" — "everyday"
> (one word) is an adjective; "every day" is correct. Visible in shots 1–3.

---

## 7. Promotional text (170 max — editable anytime, no review)

```
Meet the AI friend who holds you to your word: turns what you say into real
habits & goals, texts first when you slip, and remembers what matters. 7 days free.
```
*(159/170)* — use this to A/B messages or announce changes without a resubmit.

---

## 8. Expansion levers (the other indexed surfaces) — biggest untapped ASO gains

§1–7 optimize one locale's name/subtitle/keywords/captions. These add indexed
keyword real estate on top, at near-zero effort and no rebuild.

### 8a. Cross-localization — the single biggest lever

Apple indexes keywords **per storefront from more than one locale**, and keywords
**do not cross-pollinate** between locales — so each extra locale you fill is a
*fresh* 30 (name) + 30 (subtitle) + 100 (keywords) indexed set. The trick: put
**additional English keywords** in the secondary locale (the app is English-only,
so non-English locale users get an English app anyway).

**⚠️ Correction to the earlier cloud plan:** it claimed adding *English (UK/AU/CA)*
expands the **US** ranking. That's wrong. Each storefront indexes a **specific**
pair of locales:
- **US storefront indexes `English (U.S.)` + `Spanish (Mexico)`.** To grow US
  keywords, fill **Spanish (Mexico)** metadata with *more English terms* — they
  rank for US searchers. This is the US lever.
- `English (UK)` / `(AU)` / `(CA)` help the **UK / AU / CA** storefronts (which we
  DO ship — only the EU was dropped), **not** the US. Worth doing for those markets;
  just don't expect US lift from them.

**Ready-to-paste `Spanish (Mexico)` keyword field** — fresh terms, none repeated
from the en-US name/subtitle/keywords (repeats add nothing in the pooled index):
```
productivity,self,improvement,mindset,focus,consistency,procrastination,mentor,growth,todo,timer
```
*(96/100)* — unlocks *self improvement · productivity · focus · beat
procrastination · daily timer*, plus combinations with the en-US title Apple pools
for US search. Its name/subtitle slots can carry more English terms too (optional);
just don't duplicate words already used in the en-US set or within es-MX itself.
For UK/AU/CA: clone the en-US metadata (or vary it) into `English (UK/AU/CA)`.

### 8b. IAP display name — a wasted indexed slot

The subscription's **display name** is indexed and currently `Meroa Plus` (indexes
nothing useful). Make it carry a fresh keyword while staying legible at the
purchase sheet, e.g. **`Meroa Plus: Productivity Coach`** *(30/30)* — adds
`productivity`. Safe to change: RevenueCat maps on the **product ID**
(`meroa_monthly`), not the display name, so this doesn't touch entitlements. Set it
in App Store Connect → Subscriptions → localization; keep ≤30 chars.

### 8c. In-app event titles — recurring indexed surface (post-launch)

In-App Events' titles are indexed **and** are an editorial-featuring surface. A
periodic event (e.g. a "7-Day Accountability Challenge" or "New Year Goal Reset")
carries keywords and can win a Search/Today placement. More effort than 8a/8b and
needs the app live — a post-launch lever, not a submit-blocker.

### 8d. Conversion levers that feed ranking indirectly (other launch items)

Not keyword surfaces, but tap-through + retention are ranking inputs: an **app
preview video** (needs the running build), and a deliberate **ratings prompt**
(review volume/velocity is among the heaviest non-keyword ranking factors — wire
StoreKit `requestReview` to fire after a genuine win, never on launch). Track these
under the dev-build / Phase-8 items, not here.

---

## Sources

- [App Store indexed fields map (2026)](https://appscreenshotstudio.com/tools/app-store-indexed-fields)
- [App Store keyword field guide (2026)](https://www.applaunchflow.com/blog/app-store-keyword-field-guide-2026)
- [ASO title playbook](https://appfollow.io/blog/app-store-optimization-title)
- [Singular vs plural keywords](https://www.apptweak.com/en/aso-blog/do-singular-or-plural-keywords-rank-differently-in-aso)
- [iOS keyword field optimization](https://www.apptweak.com/en/aso-blog/how-to-optimize-your-ios-keyword-field)
- [App category ranking 2026](https://asoworld.com/en/blog/app-category-ranking-factors-2026-how-ai-powered-curation-is-changing-the-game/)
- [Cross-localization: US indexes en-US + es-MX](https://www.mobileaction.co/blog/app-store-cross-localization/)
- [Cross-localization guide: double your keywords](https://aso.dev/metadata/cross-localization/)
- [App Store localization 2026 playbook](https://appfollow.io/blog/app-store-optimization-localization)
