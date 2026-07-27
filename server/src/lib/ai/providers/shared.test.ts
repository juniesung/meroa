import { describe, expect, it } from 'vitest';

import { appFigureNumbersIn, buildConversationHistory, hasUngroundedFigure } from './shared.ts';
import type { ChatHistoryMessage } from './shared.ts';

function u(content: string): ChatHistoryMessage {
  return { role: 'user', content };
}
function a(content: string, flags: Partial<ChatHistoryMessage> = {}): ChatHistoryMessage {
  return { role: 'assistant', content, ...flags };
}

describe('buildConversationHistory', () => {
  it('regression: a request fully answered by a card+quip is dropped WITH its request, not left orphaned', () => {
    // The exact live scenario: "I need to walk the dog" got a real card
    // (isCard) plus a quip (isActionAck) — both filtered, which used to
    // leave the bare request sitting next to "Thanks" with no visible
    // reply, and the model fabricated a catch-up question to fill the gap.
    const windowed: ChatHistoryMessage[] = [
      u('I need to walk the dog'),
      a('Added "Walk the dog".', { isCard: true }),
      a('Locked in.', { isActionAck: true }),
      u('Thanks'),
    ];
    const result = buildConversationHistory(windowed);
    expect(result).toEqual([u('Thanks')]);
  });

  it('two consecutive fully-answered requests both vanish, leaving no hole at all', () => {
    const windowed: ChatHistoryMessage[] = [
      u('Make a task to water plants today'),
      a("Un-marked \"Water the plants\" — it's open again.", { isCard: true }),
      u('I need to walk the dog'),
      a('Added "Walk the dog".', { isCard: true }),
      a('Locked in.', { isActionAck: true }),
      u('Thanks'),
    ];
    expect(buildConversationHistory(windowed)).toEqual([u('Thanks')]);
  });

  it('a request with a genuine reply keeps both, card-only siblings still stripped', () => {
    const windowed: ChatHistoryMessage[] = [
      u('add a task to water plants and also do something unclear'),
      a('Added "Water the plants".', { isCard: true }),
      a('What did you want for the other one?'),
      u('never mind'),
    ];
    const result = buildConversationHistory(windowed);
    expect(result).toEqual([
      u('add a task to water plants and also do something unclear'),
      a('What did you want for the other one?'),
      u('never mind'),
    ]);
  });

  it('an ordinary conversational exchange is untouched', () => {
    const windowed: ChatHistoryMessage[] = [u('hey what up'), a('not much, you?'), u('same')];
    expect(buildConversationHistory(windowed)).toEqual(windowed);
  });

  it('the newest message (no response yet) is never dropped as an orphan', () => {
    const windowed: ChatHistoryMessage[] = [
      u('add a task to buy milk'),
      a('Added "Buy milk".', { isCard: true }),
      u('what do you think'),
    ];
    expect(buildConversationHistory(windowed)).toEqual([u('what do you think')]);
  });

  it('a plain pending-card-only exchange (isCard, no ack) also drops as a pair', () => {
    const windowed: ChatHistoryMessage[] = [
      u('delete all my tasks'),
      a('Tap to confirm: remove everything.', { isCard: true }),
      u('ok done that'),
    ];
    expect(buildConversationHistory(windowed)).toEqual([u('ok done that')]);
  });
});

describe('hasUngroundedFigure (typed figures)', () => {
  // World numbers in ordinary conversation must NEVER trip the guard — these are
  // the three live false-positive sightings that motivated the typed-figure fix.
  it('ignores a street address / zip', () => {
    expect(hasUngroundedFigure('Canon Restaurant, 2319 K St, Sacramento, CA 95816', '')).toBe(false);
  });
  it('ignores an incidental duration ("10-minute playlist")', () => {
    expect(hasUngroundedFigure("here's a 10-minute playlist to warm up", '')).toBe(false);
  });
  it('ignores crisis / phone numbers', () => {
    expect(hasUngroundedFigure('call or text 988, or 911 in an emergency', '')).toBe(false);
  });
  it('ignores a year and a clock time', () => {
    expect(hasUngroundedFigure('that dropped in 2024, doors at 8pm', '')).toBe(false);
  });

  // Real app figures still get caught when ungrounded.
  it('flags an invented savings total', () => {
    expect(hasUngroundedFigure("you're at $10 total now", 'Save $500 for a monitor: $5 of $500')).toBe(true);
  });
  it('flags an invented streak', () => {
    expect(hasUngroundedFigure("nice, that's a 9 day streak", 'Meditate: no streak right now')).toBe(true);
  });

  // …and does NOT flag an app figure that IS grounded in the facts.
  it('passes a grounded savings amount', () => {
    expect(hasUngroundedFigure('nice, $5 in so far', 'Save $500 for a monitor: $5 of $500')).toBe(false);
  });
  it('still (cheaply) flags a DERIVED amount — the classifier judges the derivation', () => {
    // $495 = $500 - $5 is legitimate, but not literally in the facts, so the
    // cheap pre-check flags it and defers to didMisstateFigure (by design).
    expect(hasUngroundedFigure('$495 to go', 'Save $500: $5 of $500')).toBe(true);
  });
});

describe('appFigureNumbersIn', () => {
  it('extracts only app-context numbers, not world numbers', () => {
    expect(appFigureNumbersIn('$5 of $300, a 4 day streak, at 2319 K St in 2024')).toEqual(
      expect.arrayContaining(['5', '300', '4']),
    );
    expect(appFigureNumbersIn('2319 K St, 95816, 2024, 8pm, 988')).toEqual([]);
    expect(appFigureNumbersIn('a 10-minute playlist with 6 songs')).toEqual([]);
    expect(appFigureNumbersIn('185 lbs, 10 glasses, 8 reps')).toEqual(
      expect.arrayContaining(['185', '10', '8']),
    );
  });
});
