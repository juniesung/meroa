import { DEFAULT_TONE, type ToneLevel } from './system-prompt.ts';

/**
 * A short, PRE-WRITTEN follow-up bubble after a genuine (non-pending)
 * create_task success — deliberately NOT model-generated. That's the whole
 * point: it can't hallucinate, can't misstate a fact, and needs no
 * claim-check, because nothing here is generated — it's a string picked
 * from a small curated pool. Zero added latency, zero new lie surface.
 *
 * Keyed off the tone slider rather than firing unconditionally: the edgiest
 * level gets none at all (matches "cut the cushioning" — no code needed to
 * special-case it, it falls out of an empty pool), the rest fire occasionally
 * rather than every time, so it reads as a light touch and not routine chatter
 * bolted onto every single card.
 *
 * routes/messages.ts tags the resulting message `actionAck: true` — the
 * same tag isActionAckMessage strips from later history, because an
 * untagged "Got it." is exactly the kind of residue that once baited the
 * conversation fast path into fabricating a claim on an unrelated later
 * turn (see the isActionAck fix).
 */
const QUIP_POOLS: Record<ToneLevel, string[]> = {
  0: ['Got it.', 'On it.', 'Done — got you covered.'],
  1: ['Got it.', 'On it.', 'Done.'],
  2: ['Got it.', 'Done.', 'On it.'],
  3: ['Boom, done.', 'Locked in.', 'Done and done.'],
  4: [],
};

const QUIP_CHANCE: Record<ToneLevel, number> = {
  0: 0.45,
  1: 0.35,
  2: 0.2,
  3: 0.4,
  4: 0,
};

export function pickTaskCreatedQuip(tone: ToneLevel | undefined): string | null {
  const level = tone ?? DEFAULT_TONE;
  const pool = QUIP_POOLS[level];
  if (pool.length === 0) return null;
  if (Math.random() > QUIP_CHANCE[level]) return null;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}
