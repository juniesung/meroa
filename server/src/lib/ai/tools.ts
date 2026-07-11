import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  createTaskInputSchema,
  editTaskPatchSchema,
  postponeInputSchema,
  recurrenceSchema,
} from '../tasks/schema.ts';

// Content-relevant subset of the app's icon set (src/components/Icon.tsx) —
// excludes chrome-only icons (chat, tasks, tools, plus, chevron, etc.) that
// would never make sense as a task's own icon.
const ICON_ENUM = ['droplet', 'clock', 'briefcase', 'dumbbell', 'wallet', 'book', 'sparkle', 'flame'];

// Shared across every tool that targets an existing task by id — checked
// server-side against the task's real current title before the tool runs
// (see actions.ts's verifyTitleHint), so a hallucinated or mismatched
// target is rejected deterministically rather than trusted on faith.
const TITLE_HINT_PROPERTY = {
  type: 'string' as const,
  description:
    "The task's title exactly as it appears in the task list in context — checked against the real task before this runs, so it must match what taskId actually points to, not a guess or something from earlier in the conversation.",
};

// Six allow-listed task actions, per phase-3-tasks.md. Field names are kept
// identical to the corresponding zod schema in lib/tasks/schema.ts wherever
// possible, so validating a tool call is a direct `schema.safeParse(input)`
// with no separate mapping layer between "what the model sends" and "what
// the executor accepts".
export const TASK_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_task',
    description:
      'Create a new task for the user to track or do. Only call this when the user clearly asked to track, do, or remember something concrete. If the title, type, or a type-specific value (target count, target amount, target minutes) is vague or unstated, do NOT call this — ask a short clarifying question in your reply instead. Never invent a number the user did not give you, and never invent a specific clock time — if they didn\'t mention one, leave dueAt (and recurrence.time) unset entirely; the app treats it as due sometime that day without a fixed deadline.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, e.g. "Chest workout".' },
        type: {
          type: 'string',
          enum: ['completion', 'checklist', 'counter', 'duration'],
          description:
            'completion: a single done/not-done thing. checklist: several sub-items to check off. counter: increments toward a target count (reps, glasses of water, dollars saved). duration: minutes toward a target, can be timed.',
        },
        icon: {
          type: 'string',
          enum: ICON_ENUM,
          description:
            'Pick whichever best matches what the task is actually about, not a default — droplet for hydration, dumbbell for exercise, book for reading/study, wallet for money, briefcase for work, clock for anything time-boxed, flame for a habit/streak, sparkle if nothing else fits.',
        },
        dueAt: {
          type: 'string',
          description:
            'Optional ISO 8601 datetime — only set this if the user actually stated a specific time (e.g. "at 6", "at noon"). Omit entirely if they only implied a day, or said nothing about timing at all. If `recurrence` is set, always omit this — put the time in recurrence.time instead; the app figures out whether the first occurrence is today or tomorrow, so never guess a date yourself here.',
        },
        note: { type: 'string', description: 'Optional note — only used for type=completion.' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required for type=checklist: the sub-item titles (1-30).',
        },
        target: {
          type: 'number',
          description: 'Required for type=counter: the target count/amount.',
        },
        unit: {
          type: 'string',
          description: 'Optional unit for type=counter, e.g. "reps", "L", "$".',
        },
        targetMinutes: {
          type: 'number',
          description: 'Required for type=duration: the target minutes.',
        },
        recurrence: {
          type: 'object',
          description: 'Only set if the user wants this to repeat on a schedule.',
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'every_n_days'] },
            byWeekday: {
              type: 'array',
              items: { type: 'string', enum: ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] },
              description: 'Required if freq=weekly.',
            },
            n: {
              type: 'number',
              description: 'Required if freq=every_n_days: repeat every N days.',
            },
            time: {
              type: 'string',
              description:
                'Optional local time of day, 24h "HH:mm" — only if the user actually gave one. Omit for a plain "every day" with no specific time.',
            },
          },
        },
        reminder: {
          type: 'boolean',
          description: 'True if the user wants a check-in around the due time.',
        },
      },
      required: ['title', 'type'],
    },
  },
  {
    name: 'edit_task',
    description:
      "Edit an existing task's title, icon, due date, or type-specific fields (checklist items, target, target minutes). Use the task's id from the task list in context — never guess an id.",
    input_schema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task to edit, from the task list in context.',
        },
        titleHint: TITLE_HINT_PROPERTY,
        title: { type: 'string' },
        icon: { type: 'string', enum: ICON_ENUM },
        dueAt: { type: 'string', description: 'ISO 8601 datetime, or omit to leave unchanged.' },
        note: { type: 'string', description: 'completion tasks only.' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'checklist tasks only: replaces the item list.',
        },
        target: { type: 'number', description: 'counter tasks only.' },
        unit: { type: 'string', description: 'counter tasks only.' },
        targetMinutes: { type: 'number', description: 'duration tasks only.' },
      },
      required: ['taskId', 'titleHint'],
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task complete, or log measurable progress toward it. For a plain completion task this toggles done/open. For counter/duration, pass `value` as the absolute amount achieved (e.g. "20 minutes" -> value: 20) — if omitted it completes fully. For checklist, pass `itemIds` to mark specific items done, or omit to mark the whole list done.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task, from the task list in context.',
        },
        titleHint: TITLE_HINT_PROPERTY,
        value: {
          type: 'number',
          description: 'Absolute measured amount for counter/duration tasks.',
        },
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Specific checklist item ids to mark done — use the exact ids listed under that task's [items: ...] in context, never a guess or the item text.",
        },
      },
      required: ['taskId', 'titleHint'],
    },
  },
  {
    name: 'progress_task',
    description:
      'Log incremental progress without finishing the task — start or stop a duration task\'s timer, or add a relative amount to a counter (e.g. "add 3 reps", "log 2 more glasses" -> amount: 2 or 3, not the new total). Use complete_task instead to finish a task or check off checklist items, and edit_task to change a target.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task, from the task list in context.',
        },
        titleHint: TITLE_HINT_PROPERTY,
        action: {
          type: 'string',
          enum: ['start_timer', 'stop_timer', 'add_to_counter'],
          description:
            'start_timer/stop_timer: duration tasks only. add_to_counter: counter tasks only.',
        },
        amount: {
          type: 'number',
          description: 'Required for add_to_counter — the relative amount to add (negative to subtract/undo).',
        },
      },
      required: ['taskId', 'titleHint', 'action'],
    },
  },
  {
    name: 'postpone_task',
    description:
      "Push a task's due date to a new time, reopening it if it was done. Use this for missed-task recovery — pair with a light, honest `reason` when the user tells you why they missed it.",
    input_schema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task, from the task list in context.',
        },
        titleHint: TITLE_HINT_PROPERTY,
        newDueAt: { type: 'string', description: 'New ISO 8601 due datetime.' },
        reason: {
          type: 'string',
          enum: ['bad_timing', 'low_energy', 'avoided'],
          description: 'Optional — only set if the user told you why they missed it.',
        },
      },
      required: ['taskId', 'titleHint', 'newDueAt'],
    },
  },
  {
    name: 'remove_task',
    description:
      "Request removing a task the user no longer wants tracked — this does NOT delete it immediately. It shows the user a card with the real task on it so they can confirm or cancel themselves; nothing is removed until they tap confirm. Only ever target a task actually present in the task list in context right now — if the user's wording could describe something from earlier in the conversation that's already gone, edited, or was never a match to begin with, say so rather than guessing a different real task just because it happens to share a title, time, or schedule.",
    input_schema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task, from the task list in context.',
        },
        titleHint: TITLE_HINT_PROPERTY,
      },
      required: ['taskId', 'titleHint'],
    },
  },
  {
    name: 'undo_last_action',
    description:
      'Reverse the most recent task action (create, complete, edit, postpone, or remove) across both chat and the Tasks tab. Call this when the user says something like "undo that" or "undo the last thing".',
    input_schema: { type: 'object', properties: {} },
  },
];

// titleHint: the task's title as the model understands it, from context —
// checked server-side against the task's actual current title before any
// of these tools execute (see actions.ts's verifyTitleHint). Catches a
// hallucinated or mismatched target deterministically, instead of trusting
// the model got taskId right just because it looks like a valid id.
const taskIdSchema = z.object({ taskId: z.string().uuid(), titleHint: z.string().min(1) });

const progressTaskToolSchema = z.discriminatedUnion('action', [
  taskIdSchema.extend({ action: z.literal('start_timer') }),
  taskIdSchema.extend({ action: z.literal('stop_timer') }),
  taskIdSchema.extend({ action: z.literal('add_to_counter'), amount: z.number() }),
]);

export const AI_TOOL_SCHEMAS = {
  create_task: createTaskInputSchema,
  edit_task: taskIdSchema.merge(editTaskPatchSchema),
  complete_task: taskIdSchema.extend({
    value: z.number().optional(),
    itemIds: z.array(z.string()).optional(),
  }),
  progress_task: progressTaskToolSchema,
  postpone_task: taskIdSchema.merge(postponeInputSchema),
  remove_task: taskIdSchema,
  undo_last_action: z.object({}),
} as const;

export type AiToolName = keyof typeof AI_TOOL_SCHEMAS;

export function isAiToolName(name: string): name is AiToolName {
  return name in AI_TOOL_SCHEMAS;
}

export type ValidateToolInputResult<T extends AiToolName> =
  { ok: true; data: z.infer<(typeof AI_TOOL_SCHEMAS)[T]> } | { ok: false; error: string };

/** Server backstop: structurally validates a tool call before it ever reaches the executor. */
export function validateToolInput<T extends AiToolName>(
  name: T,
  rawInput: unknown,
): ValidateToolInputResult<T> {
  const schema = AI_TOOL_SCHEMAS[name];
  const result = schema.safeParse(rawInput);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const path = issue?.path.join('.') || 'input';
  return {
    ok: false,
    error: `${path}: ${issue?.message ?? 'invalid input'} — ask the user for the missing or corrected value rather than guessing.`,
  };
}

// Recurrence sub-schema exported for reuse by the AI context builder when
// summarizing an existing template's schedule back into prose.
export { recurrenceSchema };
