import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../env.ts';
import { buildSystemPrompt, type ChatUserContext } from './system-prompt.ts';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Streaming, non-thinking replies don't need much room — keep this modest so a
// runaway response can't stall the SSE connection.
const MAX_OUTPUT_TOKENS = 1024;

// Conversation context window: cap both message count and total characters so
// a long-running relationship doesn't balloon every request's token cost.
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 24_000;

// Between finishing one "text" and starting the next, pause briefly so a
// multi-bubble reply feels like separate messages arriving, not one message
// artificially chopped up.
const SEGMENT_PAUSE_MIN_MS = 500;
const SEGMENT_PAUSE_MAX_MS = 1100;

export type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'segment_end'; text: string }
  | { type: 'stream_end' }
  | { type: 'error'; retryable: boolean; message: string };

function windowHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);

  let totalChars = 0;
  let startIndex = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    totalChars += recent[i]!.content.length;
    startIndex = i;
    if (totalChars > MAX_HISTORY_CHARS) break;
  }
  return recent.slice(startIndex);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a reply from Claude given the conversation so far (must already
 * include the user's just-sent message). Meroa may send a reply as several
 * separate "texts" (CLAUDE.md's iMessage feel) — signaled by a blank line in
 * the model's output. Consumers get `delta` events for the segment currently
 * arriving, `segment_end` once a segment is complete, and `stream_end` once
 * the whole turn is done. Never throws — always terminates in `stream_end`
 * or `error`.
 */
export async function* streamChatReply(
  history: ChatHistoryMessage[],
  user: ChatUserContext,
): AsyncGenerator<ChatStreamEvent> {
  const windowed = windowHistory(history).filter((m) => m.content.trim().length > 0);

  try {
    const stream = client.messages.stream({
      model: env.ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(user),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: windowed,
    });

    // Segment-splitting state. `buffer` holds the current segment's raw text;
    // `emittedLength` is how much of it has already gone out as `delta`. A
    // trailing run of newlines is held back — not yet emitted — since it
    // might turn into a blank-line boundary once more text arrives, and a
    // boundary itself should never appear as visible text in a bubble.
    let buffer = '';
    let emittedLength = 0;
    let anySegmentEmitted = false;

    // Flushes only the portion of `buffer` known-safe to reveal: everything
    // except a trailing run of newlines, which might still turn into a
    // blank-line boundary once more text arrives. Only meaningful once no
    // *resolved* boundary remains in the buffer (see the while-loop below,
    // which handles those first, each capped at its own boundary index).
    function* flushSafe(): Generator<ChatStreamEvent> {
      const trailingNewlines = buffer.match(/\n+$/);
      const safeLength = trailingNewlines ? buffer.length - trailingNewlines[0].length : buffer.length;
      if (safeLength > emittedLength) {
        yield { type: 'delta', text: buffer.slice(emittedLength, safeLength) };
        emittedLength = safeLength;
      }
    }

    for await (const event of stream) {
      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
      buffer += event.delta.text;

      // A single chunk can contain a boundary *and* the start of the next
      // segment's text in one piece — resolve every complete boundary first,
      // each capped at its own index, before falling back to the trailing-
      // newline holdback for whatever's left unresolved at the very end.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        if (boundary > emittedLength) {
          yield { type: 'delta', text: buffer.slice(emittedLength, boundary) };
        }
        const segmentText = buffer.slice(0, boundary).trim();
        if (segmentText) {
          yield { type: 'segment_end', text: segmentText };
          anySegmentEmitted = true;
        }

        buffer = buffer.slice(boundary).replace(/^\n+/, '');
        emittedLength = 0;

        if (segmentText) {
          await sleep(SEGMENT_PAUSE_MIN_MS + Math.random() * (SEGMENT_PAUSE_MAX_MS - SEGMENT_PAUSE_MIN_MS));
        }

        boundary = buffer.indexOf('\n\n');
      }

      yield* flushSafe();
    }

    const final = await stream.finalMessage();
    const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const modelText = textBlock?.text ?? '';

    let remaining: string;
    if (final.stop_reason === 'refusal') {
      remaining = "That's not something I can help with — let's talk about something else.";
    } else if (final.stop_reason === 'max_tokens' && modelText.trim().length === 0 && buffer.trim().length === 0) {
      remaining = 'Sorry, that got cut off on my end — mind asking again?';
    } else {
      yield* flushSafe();
      remaining = buffer.trim();
    }

    // Guarantee at least one segment per turn — a genuinely empty model
    // reply (rare, but possible on any stop_reason) must never leave the
    // user's message met with silence and no error.
    if (!remaining && !anySegmentEmitted) {
      remaining = "Hm, not sure what to say to that — try me again?";
    }

    if (remaining) yield { type: 'segment_end', text: remaining };
    yield { type: 'stream_end' };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
      yield {
        type: 'error',
        retryable: true,
        message: "Meroa's a little overloaded right now — try again in a moment.",
      };
    } else if (err instanceof Anthropic.APIConnectionError) {
      yield { type: 'error', retryable: true, message: 'Lost connection — try sending that again.' };
    } else {
      yield { type: 'error', retryable: false, message: 'Something went wrong on my end.' };
    }
  }
}
