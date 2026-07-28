# Meroa marketing website — build handoff (self-contained)

> **How to use this doc.** Copy it into the new `meroa-web` repo (e.g. as
> `PLAN.md` or `CLAUDE.md`) and start a fresh Claude Code session rooted at
> `/Users/peter/Developer/meroa-web`. Everything the build needs — design tokens,
> component specs, the exact logo SVG, the persona voice, the scripted demo
> content — is inlined here, so the new session needs **nothing** from the `meroa`
> app repo.

---

## 1. What we're building & why

A **marketing website for Meroa** (a relationship-first AI companion iOS app) whose
job is to convert **cold TikTok/Instagram traffic** into App Store downloads.

Social traffic is impulsive and low-intent, so the strategy (validated by research)
is: **let visitors feel Meroa's personality before any download wall**, then funnel
them to the App Store. The centerpiece is a **scripted example-chat showcase** — a
canned conversation that types out live, showing Meroa's voice + its "talk → it
gets tracked" loop.

**Locked decisions:**
- **Separate repo** `meroa-web` (its own Vercel project). The app/API repo is untouched.
- **Scripted demo** (canned convo, no backend, $0/visitor, zero abuse/cost/safety
  risk). NOT a live AI chat.
- **Simple App Store pipeline**: App Store badge + Apple Smart App Banner + deep
  link, with device detection (iOS → App Store; Android/desktop → email waitlist).

## 2. Tech stack

- **Next.js (App Router) + TypeScript + Tailwind CSS**, **Framer Motion** for the
  typing / card-reveal / scroll animations. Deploy on **Vercel**.
- Scaffold: `npx create-next-app@latest meroa-web` (TypeScript + Tailwind + App
  Router + ESLint). Add `framer-motion`.
- Mobile-first (social traffic is mobile), dark-first, fast (SSG, optimized
  images/fonts). Add lightweight privacy-safe analytics (Vercel Analytics or
  Plausible) to measure visit → CTA click → store. No PII, no message content.

## 3. Design system (Meroa's exact theme — dark, near-black, blue accent)

**Color tokens** (put in `tailwind.config.ts` `theme.extend.colors`):
```
blue        #0A84FF     blueDeep   #2563EB     blueLight  #5AB0FF
gradient    #1E8BFF → #0A6DF0   (buttons + user chat bubbles)
text        #F5F7FA     dim        #8E949E     faint      #5B6068
bg          #030507     surface    #111318     card       #191C22    card2  #1F232B
bubbleAI    #1C1F25
border      rgba(255,255,255,0.06)     borderStrong  rgba(255,255,255,0.10)
success     #30D158     danger     #FF453A
```
**Radii:** bubble 20 (tail corner 6), card 18, section 16, control 18/14, chip 10,
pill 999.
**Type:** big header 26–28px / 700 / −0.5 tracking · eyebrow 11px / 700 / +1.2
tracking / UPPERCASE · body 15px · meta 12–13px · chat bubble 15px / 20 line-height.
System font stack (SF/system-ui). Dark-first; subtle motion ("satisfying, not
distracting").

### 3a. `MeroaMark` logo (exact SVG — a gradient "M" with 3 chat dots)
Recreate as an inline SVG. viewBox `0 0 64 64`:
```html
<svg viewBox="0 0 64 64" width="{size}" height="{size}">
  <defs>
    <linearGradient id="meroaMark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="#5AB0FF"/>
      <stop offset="100%" stop-color="#0A6DF0"/>
    </linearGradient>
  </defs>
  <path fill="url(#meroaMark)" d="M10 12 C10 10 12 8 14 8 C17 8 19 10 20 13 L26 34 C27 37 29 37 30 34 L36 13 C37 10 39 8 42 8 C44 8 46 10 46 12 L46 40 C46 46 42 50 36 50 L34 50 L30 56 L28 50 L20 50 C14 50 10 46 10 40 Z"/>
  <circle cx="24" cy="42" r="1.6" fill="#0A2540"/>
  <circle cx="28" cy="42" r="1.6" fill="#0A2540"/>
  <circle cx="32" cy="42" r="1.6" fill="#0A2540"/>
</svg>
```
Optional blue glow: `filter: drop-shadow(0 0 10px rgba(10,132,255,.55))`. Use it as
the favicon + OG mark too.

### 3b. Chat `Bubble` (iMessage feel)
- **User (me):** right-aligned; **blue gradient** `#1E8BFF→#0A6DF0` (top→bottom);
  border-radius 20 with the **bottom-right** corner tightened to 6; subtle blue
  glow. Text `#fff`, 15px / 20 line-height.
- **AI (Meroa):** left-aligned; flat `#1C1F25`; radius 20 with the **bottom-left**
  corner tightened to 6. Same text size.
- `max-width: ~78%`; padding 14px horizontal / 9px vertical; tight vertical
  grouping when the same sender sends several in a row.
- **Typing indicator:** three dots pulsing in an AI bubble.

### 3c. `TaskCard` / habit card (the "it got tracked" visual)
- Card: bg `#191C22`, 1px border `rgba(255,255,255,0.10)`, radius 18, padding 14.
  A subtle top inner highlight (a "3D banner" look) tinted with the accent.
- Left **icon chip**: 34×34, radius 10, background = accent at ~14% opacity, a
  stroke icon in the accent color (e.g. a dumbbell for a gym task).
- **Title**: `#F5F7FA`, 15px / 600. **Meta** line below: `#8E949E`, 12px
  (e.g. "Daily · day 1 streak"). A small **goal chip** row can show "→ Goal name".
- **Right status**: a 24×24 pill checkbox — empty ring (border `rgba(255,255,255,
  0.10)`) when open, filled **blue** with a white check when done.
- **Progress bar** (counter/duration): height 6, radius 999, track `border` color,
  fill = blue→blueLight gradient.
- Accent defaults to blue `#0A84FF`; a goal-linked task borrows its goal's color
  (green for savings, etc.) — for the showcase, blue is fine.

## 4. The persona voice (so the site's copy sounds like Meroa)

Lowercase-casual, playful, a little edge, hard-love but warm underneath. Real
example lines from the app:
- "meaning to and doing it are two different sports lol"
- "bet."
- "lmk what you're hitting and the weight, and yeah i'm gonna have opinions on the numbers"
- "no lol. we both know how that one ends."
- Tone is a **warm↔edgy slider** (0 warmest … 4 edgiest). Same situation, five ways
  (great content for an interactive "set the vibe" toggle on the site):

| Level | "skipped the gym again" → |
|---|---|
| 0 Warmest | no shame at all, some weeks are just heavy. want to start tiny tomorrow? |
| 1 Warm | hey, it happens. what'd make tomorrow a little easier to show up? |
| 2 Balanced | third one this week though. what's actually getting in the way? |
| 3 Edgy | third this week. "tomorrow" isn't a plan. what's the real blocker? |
| 4 Edgiest | you and the gym are basically pen pals now. three skips, quit stalling. what's up? |

## 5. The scripted chat showcase (centerpiece)

A phone-framed dark chat mockup that **plays a canned conversation** with realistic
typing timing (typing dots → bubble appears), then a **habit card animates in**.
Scroll-triggered + replayable. Store the script as data; a `ChatShowcase` component
plays it. **No API calls.**

Recommended `data/showcase-script.ts` beats (role, text, then a card step):
```
user  "i've been meaning to work out"
meroa "meaning to and doing it are two different sports lol"
meroa "want me to make it a real thing so it's harder to ghost?"
user  "yeah let's do it"
meroa "bet."
CARD  → habit card: icon=dumbbell, title="Work out", meta="Daily · day 1 🔥", blue accent
meroa "lmk what you hit and i'll judge the numbers a little"
```
This shows personality + the talk→track loop + a real card, in ~7 beats. Keep the
typing delays human (~600–1200ms per message, a beat longer before the card).

## 6. Site structure (v1 — one scrolling page)

1. **Hero** — MeroaMark, a big gradient headline that continues the TikTok hook
   ("The AI friend that won't let you flake"), one-line subhead, device-aware App
   Store CTA.
2. **Scripted chat showcase** (§5) — the emotional centerpiece.
3. **Value props** (3–4) — the core loop (talk → tracked → progress everywhere);
   personality + the **tone toggle** (§4 table, interactive); whole-life companion;
   hard-love accountability. Use recreated bubbles/cards as the visuals.
4. **Social proof** — star rating + testimonials. ⚠️ **Honesty rule:** never
   fabricate reviews presented as real. For launch, omit or use clearly-illustrative
   copy; swap in real testimonials once you have users.
5. **Final CTA** — App Store badge + Smart App Banner + device detection (§7).
6. **Footer** — links to the live legal pages (currently served at
   `https://meroa-production.up.railway.app/privacy` `/terms` `/support` `/safety`;
   move under the real domain later), socials.

## 7. App Store pipeline (simple)

- **Apple Smart App Banner** meta tag in `<head>` (native Safari download bar on
  iOS): `<meta name="apple-itunes-app" content="app-id=APPID">`.
- **App Store badge/button** → the listing URL.
- **Device detection** (`lib/device.ts`, UA-based): iOS → show App Store badge +
  banner; Android/desktop → show an **email waitlist** form (no Android app yet), so
  non-iOS visitors aren't lost. Waitlist via a tiny `app/api/waitlist/route.ts` or a
  form service (Tally/Formspree).
- ⚠️ The real **`app-id` / listing URL only exists once the iOS app is submitted to
  App Store Connect.** Use a placeholder constant now and swap it in later.

## 8. Prerequisites / notes (human)

- `npx create-next-app` the repo, `git init`, connect it to a Vercel project.
- Acquire a **domain** (`meroa.app` currently doesn't resolve) and point DNS at Vercel.
- Swap the App Store `app-id`/URL in once the app is live.

## 9. Verification

- `npm run dev` → showcase types out + card reveals; page responsive at mobile &
  desktop widths; theme matches (bg `#030507`, blue accents, gradient bubbles/CTAs).
- Device detection: iOS UA → App Store CTA + Smart App Banner; desktop/Android →
  waitlist; submitting records an email.
- Lighthouse: strong performance / SEO / a11y; OG + meta tags render on link-share.
- Vercel preview deploy; verify Smart App Banner + store link on a real iPhone (once
  the `app-id` exists).

## 10. Out of scope for v1 (deferred)

Live interactive AI demo; deferred deep linking (Branch/AppsFlyer); a real
phone-entry web chat (a possible v2); Android. None require any backend.
