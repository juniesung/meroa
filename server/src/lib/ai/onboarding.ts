// First-run, Meroa-driven guided tour.
//
// A brand-new user lands in the chat with the seeded WELCOME_MESSAGE, which
// offers a quick tour of how Meroa works. If they take it, Meroa walks them
// through a fixed, ordered set of topics — one per turn — in her own voice.
//
// This is deliberately NOT a scripting engine. It rides the normal ACT/NARRATE
// reply pipeline: coverage ORDER and TERMINATION live here in code (a
// guarantee), while the actual phrasing, and any detour when the user asks a
// real question or requests a real action mid-tour, stay with the model (a
// suggestion). See docs/chat-architecture.md — a guarantee lives in code.
//
// The only state is `prefs.onboardingTour = { active, step }` (jsonb, no
// migration). While active, routes/messages.ts injects buildOnboardingDirector
// into the reply pass and advances the step server-side each turn.

export type OnboardingTourState = { active: boolean; step: number };

// The ordered tour. `note` is the per-topic instruction spliced into the
// director block below — it says WHAT to introduce, never verbatim copy.
export const TOUR_TOPICS = [
  {
    key: 'loop',
    note: "Introduce the core idea of how you work: they never have to manage anything by hand — they just talk to you, like they're doing right now, and you turn what they say into tasks and goals automatically. The very same thing then shows up across the Chat, Tasks, and Goals tabs — it's one shared record, not separate copies to keep in sync. Make it concrete using their own real goal and/or first task by name if you're given them below.",
  },
  {
    key: 'tone',
    note: "Show them they're in control of your personality: how warm or blunt and edgy you are is a slider they own, and they can change it any time. Tell them where: tap the ⋯ menu at the top of this chat and pick \"Voice tone\" (it also lives in Settings). Keep it light — they set the vibe, you follow it.",
  },
  {
    key: 'memory_clear',
    note: "Cover two trust-and-control things briefly. First, memory: you remember the things that matter to them across conversations, and they're fully in charge of it — the ⋯ menu → Memory lets them see, edit or delete anything you remember, mark something private, or tell you to stop bringing something up. Second, clearing the chat: the ⋯ menu → Clear conversation wipes this chat and starts fresh whenever they want — and reassure them their tasks, goals and progress are always kept; only the chat text clears.",
  },
  {
    key: 'you_tab',
    note: "Point them to the You tab (bottom-right): it's their progress home — a streak, their stats, and achievement badges they earn as they go. Briefly note that tasks come in a few flavors (one-offs, recurring things, reminders) and goals in a few kinds, and the nice part is that completing a task or logging progress updates everything at once. This is the LAST stop — wrap the tour up warmly: they're all set, and they can just talk to you like a friend whenever. Do NOT ask whether they want to keep going here.",
  },
] as const;

/**
 * Reads the tour state out of a user's prefs blob. Returns null unless a tour
 * is genuinely active with a valid step — so callers can treat non-null as
 * "this turn is a tour turn".
 */
export function readTourState(
  prefs: Record<string, unknown> | null | undefined,
): OnboardingTourState | null {
  const raw = prefs?.onboardingTour;
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as { active?: unknown }).active === true &&
    typeof (raw as { step?: unknown }).step === 'number'
  ) {
    return { active: true, step: (raw as { step: number }).step };
  }
  return null;
}

/**
 * The next state after a tour turn. A skip ends it immediately; otherwise the
 * step advances, and running past the last topic ends it too. Pure — the caller
 * persists the result.
 */
export function nextTourState(
  current: OnboardingTourState,
  opts: { skip?: boolean } = {},
): OnboardingTourState {
  if (opts.skip) return { active: false, step: current.step };
  const step = current.step + 1;
  if (step >= TOUR_TOPICS.length) return { active: false, step };
  return { active: true, step };
}

// Short, clear opt-outs the user can type at any point to end the tour. Kept
// deliberately tight and anchored to short messages so it can't swallow a real
// sentence that merely contains one of these words ("don't skip leg day").
const SKIP_PATTERN =
  /^\s*(skip( it| the tour)?|no thanks|no thank you|nah|not now|not right now|maybe later|later|i'?m good|im good|just dive in|dive in|stop( the tour)?|no tour)\s*[.!]*\s*$/i;

export function isTourSkipIntent(message: string): boolean {
  return SKIP_PATTERN.test(message.trim());
}

/**
 * The director block injected into the reply pass while a tour is active. It
 * frames the turn, names the ONE topic to introduce (or a warm wrap-up on
 * skip / after the last topic), and hard-constrains style so it can't turn into
 * a lecture or trip the output guards.
 */
export function buildOnboardingDirector(args: {
  step: number;
  skip?: boolean;
  displayName?: string | null;
  goalName?: string | null;
  taskTitle?: string | null;
}): string {
  const name = args.displayName?.trim() || null;
  const nameLine = name ? `Their name is ${name}.` : '';

  if (args.skip) {
    return [
      '# You are wrapping up the intro tour',
      `The user just asked to skip the quick tour of how you work. Respect that immediately. ${nameLine}`.trim(),
      "In ONE short, warm line: no problem, they can just talk to you like a friend whenever and you'll handle the rest — and they can always ask you to show them around later. Do not explain any feature, do not list anything, and do not ask a question. Then stop.",
    ]
      .filter(Boolean)
      .join('\n');
  }

  const topic = TOUR_TOPICS[args.step];
  // Defensive: an out-of-range step shouldn't happen (the route ends the tour
  // when the list is exhausted), but if it does, wrap up rather than crash.
  if (!topic) {
    return [
      '# You are wrapping up the intro tour',
      "In ONE short, warm line let them know they're all set and can just talk to you whenever. Don't list features or ask a question.",
    ].join('\n');
  }

  const refLines: string[] = [];
  if (args.goalName) refLines.push(`Their real goal is named "${args.goalName}" — use it as the live example.`);
  if (args.taskTitle) refLines.push(`Their first real task is named "${args.taskTitle}".`);
  const isLast = args.step === TOUR_TOPICS.length - 1;

  return [
    '# You are giving a brand-new user a short, guided intro to how you work',
    `This is their very first conversation. You're showing them around — warmly, like a friend, not like a product tour. ${nameLine}`.trim(),
    '',
    '## The ONE thing to introduce in this reply',
    topic.note,
    ...(refLines.length ? ['', ...refLines] : []),
    '',
    '## How to say it',
    '- IF what they just said is emotional, vulnerable, stressed, grieving, anxious, or heavy in ANY way: DROP the tour for this reply entirely. Just be warm and fully present — mirror what they\'re feeling and offer to listen or help. Introduce NO feature, give NO app tip, add NO nudge or question about the walkthrough. Being present matters more than the tour; it waits.',
    "- Otherwise: they have already opted into this walkthrough by replying — NEVER re-ask whether they want a tour or to \"dive in\", and never repeat the welcome's offer. Just go straight into showing them the thing above.",
    '- First, react in one line to whatever they just said or did — then move into the intro. If they just asked you a real question or had you do something real, that came first and this is a natural aside after it.',
    '- Keep it to one or two short bubbles, casual and in your own voice. No bullet lists, no headings, no "Feature:" framing, no wall of text.',
    '- Do NOT dump every feature — cover ONLY the one thing above this turn.',
    isLast
      ? '- This is the last stop, so close the tour warmly and do not ask whether to keep going.'
      : "- End with a light, natural nudge to keep going (a quick question or an invite), so they know there's a little more.",
    '- Never state a number, streak, total, count, or figure of any kind — refer to their goals and tasks by NAME only. Spell out quantities as words like "a few" if you must; never a digit.',
    '- You have already greeted them in the seeded welcome message, so don\'t re-introduce yourself.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
