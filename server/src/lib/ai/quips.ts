import type { VibePreset } from './system-prompt.ts';

/**
 * A short, PRE-WRITTEN follow-up bubble after a genuine (non-pending)
 * create_task success — deliberately NOT model-generated. That's the whole
 * point: it can't hallucinate, can't misstate a fact, and needs no
 * claim-check, because nothing here is generated — it's a string picked
 * from a small curated pool. Zero added latency, zero new lie surface.
 *
 * Ties into the preset system rather than firing unconditionally: Direct
 * gets none at all (matches "cut the padding entirely" — no code needed to
 * special-case it, it falls out of an empty pool), the others fire
 * occasionally rather than every time, so it reads as a light touch and
 * not routine chatter bolted onto every single card.
 *
 * routes/messages.ts tags the resulting message `actionAck: true` — the
 * same tag isActionAckMessage strips from later history, because an
 * untagged "Got it." is exactly the kind of residue that once baited the
 * conversation fast path into fabricating a claim on an unrelated later
 * turn (see the isActionAck fix).
 */
const QUIP_POOLS: Record<VibePreset, string[]> = {
  balanced: ['Got it.', 'Done.', 'On it.'],
  chill: ['got it', 'done', 'on it'],
  supportive: ['Got it.', 'On it.', 'Done — got you covered.'],
  direct: [],
  playful: ['Boom, done.', 'Locked in.', 'Got it, chief.', 'Done and done.'],
};

const QUIP_CHANCE: Record<VibePreset, number> = {
  balanced: 0.2,
  chill: 0.45,
  supportive: 0.45,
  direct: 0,
  playful: 0.55,
};

export function pickTaskCreatedQuip(style: VibePreset | undefined): string | null {
  const preset = style ?? 'balanced';
  const pool = QUIP_POOLS[preset];
  if (pool.length === 0) return null;
  if (Math.random() > QUIP_CHANCE[preset]) return null;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}
