import { describe, expect, it } from 'vitest';

import { buildConversationHistory } from './shared.ts';
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
