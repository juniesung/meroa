import { describe, expect, it } from 'vitest';

import { findAmbiguousTaskMatch } from './ambiguity.ts';

// Structural backstop for chat-architecture.md §0's "make the server
// refuse" — see the function's own comment for the live bug this closes
// (docs/goal-manual-editing-plan.md §4).

describe('findAmbiguousTaskMatch', () => {
  const water = { id: 't1', title: 'Water the plants' };
  const waterFilter = { id: 't2', title: 'drink 8 glasses of water' };
  const gym = { id: 't3', title: 'Go to the gym' };

  it('flags the live bug: "mark water done" with two water-matching tasks open', () => {
    const result = findAmbiguousTaskMatch('mark water done', [water, waterFilter, gym]);
    expect(result).not.toBeNull();
    expect(result?.candidates.map((c) => c.id).sort()).toEqual(['t1', 't2']);
  });

  it('is NOT ambiguous when a word distinguishes exactly one candidate: "mark the plants done"', () => {
    const result = findAmbiguousTaskMatch('mark the plants done', [water, waterFilter, gym]);
    expect(result).toBeNull();
  });

  it('is NOT ambiguous when only one task matches at all', () => {
    const result = findAmbiguousTaskMatch('finished the gym session', [water, waterFilter, gym]);
    expect(result).toBeNull();
  });

  it('is NOT ambiguous when nothing matches — an unrelated report', () => {
    const result = findAmbiguousTaskMatch('had a great day today', [water, waterFilter, gym]);
    expect(result).toBeNull();
  });

  it('anaphora ("mark that done") strips to nothing significant — model judgment stands', () => {
    const result = findAmbiguousTaskMatch('mark that done', [water, waterFilter, gym]);
    expect(result).toBeNull();
  });

  it('a single open task is never ambiguous, however generic the reference', () => {
    const result = findAmbiguousTaskMatch('mark water done', [water]);
    expect(result).toBeNull();
  });

  it('three-way match stays ambiguous unless a word is unique to one', () => {
    const waterFilterChange = { id: 't4', title: 'Change the water filter' };
    const result = findAmbiguousTaskMatch('mark water done', [water, waterFilter, waterFilterChange]);
    expect(result).not.toBeNull();
    expect(result?.candidates).toHaveLength(3);
  });

  it('a word unique to one candidate distinguishes it even among a larger group', () => {
    const waterFilterChange = { id: 't4', title: 'Change the water filter' };
    // "filter" only appears in waterFilterChange's title among the three —
    // that's the distinguishing word, even though "water" alone would have
    // matched all three.
    const result = findAmbiguousTaskMatch('mark water filter done', [water, waterFilter, waterFilterChange]);
    expect(result).toBeNull();
  });
});
