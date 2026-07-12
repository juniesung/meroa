import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { z } from 'zod';

import {
  createTaskInputSchema,
  editTaskPatchSchema,
  postponeInputSchema,
  recurrenceSchema,
} from '../tasks/schema.ts';
import {
  createToolParamsSchema,
  TOOL_FIELD_TYPES,
  TOOL_TEMPLATES,
  toolFieldInputSchema,
} from '../tools/schema.ts';

// Content-relevant subset of the app's icon set (src/components/Icon.tsx) —
// excludes chrome-only icons (chat, tasks, tools, plus, chevron, etc.) that
// would never make sense as a task's own icon.
const ICON_ENUM = ['droplet', 'clock', 'briefcase', 'dumbbell', 'wallet', 'book', 'sparkle', 'flame'];

// Shared across every tool that targets an existing task by ref — checked
// server-side against the task's real current title before the tool runs
// (see actions.ts's verifyTitleHint), so a hallucinated or mismatched
// target is rejected deterministically rather than trusted on faith.
const TITLE_HINT_PROPERTY = {
  type: 'string' as const,
  description:
    "The task's title exactly as it appears in the task list in context — checked against the real task before this runs, so it must match what taskRef actually points to, not a guess or something from earlier in the conversation.",
};

// A task's turn-scoped ref from the task list in context, e.g. "T2" — never
// a database id. Models copy these far more reliably than a ~20-token UUID
// (observed: a UUID digit run silently corrupted, identically, three times
// in a row); the server resolves the ref back to a real id and rejects
// anything not in the current list (lib/ai/task-context.ts, lib/ai/actions.ts).
const TASK_REF_PROPERTY = {
  type: 'string' as const,
  description:
    "The task's ref exactly as shown in the task list in context, e.g. \"T2\" — never a database id, and never invented.",
};

// Same pattern as TASK_REF_PROPERTY/TITLE_HINT_PROPERTY, for tools.
const TOOL_REF_PROPERTY = {
  type: 'string' as const,
  description:
    "The tool's ref exactly as shown in the tools list in context, e.g. \"L2\" — never a database id, and never invented.",
};
const TOOL_NAME_HINT_PROPERTY = {
  type: 'string' as const,
  description:
    "The tool's name exactly as it appears in the tools list in context — checked against the real tool before this runs, so it must match what toolRef actually points to.",
};
const TOOL_TEMPLATES_ENUM = [...TOOL_TEMPLATES];
const TOOL_FIELD_TYPES_ENUM = [...TOOL_FIELD_TYPES];

// Six allow-listed task actions, per phase-3-tasks.md. Field names are kept
// identical to the corresponding zod schema in lib/tasks/schema.ts wherever
// possible, so validating a tool call is a direct `schema.safeParse(input)`
// with no separate mapping layer between "what the model sends" and "what
// the executor accepts".
export const AI_TOOLS: Anthropic.Tool[] = [
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
      "Edit an existing task's title, icon, due date, or type-specific fields (checklist items, target, target minutes). Use the task's ref from the task list in context — never guess one. For a recurring task, this always edits the whole series (the schedule, title, or target), never a single occurrence.",
    input_schema: {
      type: 'object',
      properties: {
        taskRef: TASK_REF_PROPERTY,
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
      required: ['taskRef', 'titleHint'],
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task complete, or log measurable progress toward it. For a plain completion task this toggles done/open. For counter/duration, pass `value` as the absolute amount achieved (e.g. "20 minutes" -> value: 20) — if omitted it completes fully. For checklist, pass `itemRefs` to mark specific items done, or omit to mark the whole list done. For a recurring task, this always acts on today\'s occurrence — if there isn\'t one due today, it fails rather than touching the schedule.',
    input_schema: {
      type: 'object',
      properties: {
        taskRef: TASK_REF_PROPERTY,
        titleHint: TITLE_HINT_PROPERTY,
        value: {
          type: 'number',
          description: 'Absolute measured amount for counter/duration tasks.',
        },
        itemRefs: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Specific checklist item refs to mark done — use the exact refs listed under that task's [items: ...] in context (e.g. \"T2.1\"), never a guess or the item text.",
        },
      },
      required: ['taskRef', 'titleHint'],
    },
  },
  {
    name: 'progress_task',
    description:
      'Log incremental progress without finishing the task — start or stop a duration task\'s timer, or add a relative amount to a counter (e.g. "add 3 reps", "log 2 more glasses" -> amount: 2 or 3, not the new total). Use complete_task instead to finish a task or check off checklist items, and edit_task to change a target. For a recurring task, this always acts on today\'s occurrence.',
    input_schema: {
      type: 'object',
      properties: {
        taskRef: TASK_REF_PROPERTY,
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
      required: ['taskRef', 'titleHint', 'action'],
    },
  },
  {
    name: 'postpone_task',
    description:
      "Push a task's due date to a new time, reopening it if it was done. Use this for missed-task recovery — pair with a light, honest `reason` when the user tells you why they missed it. For a recurring task, this always acts on today's occurrence.",
    input_schema: {
      type: 'object',
      properties: {
        taskRef: TASK_REF_PROPERTY,
        titleHint: TITLE_HINT_PROPERTY,
        newDueAt: { type: 'string', description: 'New ISO 8601 due datetime.' },
        reason: {
          type: 'string',
          enum: ['bad_timing', 'low_energy', 'avoided'],
          description: 'Optional — only set if the user told you why they missed it.',
        },
      },
      required: ['taskRef', 'titleHint', 'newDueAt'],
    },
  },
  {
    name: 'remove_task',
    description:
      "Request removing a task the user no longer wants tracked — this does NOT delete it immediately. It shows the user a card with the real task on it so they can confirm or cancel themselves; nothing is removed until they tap confirm. Call this as soon as you know which task they mean — don't ask the user to confirm in chat text first; the tap on the card IS the confirmation, so asking again in words just makes them confirm twice. Only ever target a task actually present in the task list in context right now — if the user's wording could describe something from earlier in the conversation that's already gone, edited, or was never a match to begin with, say so rather than guessing a different real task just because it happens to share a title, time, or schedule. For a single task, use this; for several at once, use remove_tasks instead.",
    input_schema: {
      type: 'object',
      properties: {
        taskRef: TASK_REF_PROPERTY,
        titleHint: TITLE_HINT_PROPERTY,
        scope: {
          type: 'string',
          enum: ['occurrence', 'series'],
          description:
            'Recurring tasks only. "series" (the default) stops the whole repeating task — use this when the user means "delete/remove/stop this [task]" generally. "occurrence" only skips today\'s instance and leaves the schedule running — use this for "skip today" / "not today" wording.',
        },
      },
      required: ['taskRef', 'titleHint'],
    },
  },
  {
    name: 'remove_tasks',
    description:
      'Request removing several tasks at once — same pending-confirmation flow as remove_task (nothing is removed until the user taps Confirm), but a single card and a single tap for all of them. Call this as soon as you know which tasks they mean — don\'t ask the user to confirm in chat text first; the tap on the card IS the confirmation. Use this instead of calling remove_task repeatedly whenever the user wants more than one task gone in the same request (e.g. "remove all my tasks", "clear the finished ones", "delete the water and pushups tasks").',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskRef: TASK_REF_PROPERTY,
              titleHint: TITLE_HINT_PROPERTY,
            },
            required: ['taskRef', 'titleHint'],
          },
          description: 'Every task to remove, each with its ref and title exactly as shown in the task list.',
        },
        scope: {
          type: 'string',
          enum: ['occurrence', 'series'],
          description:
            'Applies to any recurring tasks among items — "series" (the default) stops the whole repeating task; "occurrence" only skips today\'s instance for those.',
        },
      },
      required: ['items'],
    },
  },
  // --- tools (long-term trackers) --------------------------------------
  // A tool's own ref namespace ("L2", "L2.1" — mnemonic: tooL) is distinct
  // from task refs ("T2") so a regex can't confuse the two families; both
  // resolve through the same per-turn TurnRefs map (lib/ai/task-context.ts).
  {
    name: 'create_tool',
    description:
      'Show the user a preview of a new tracker/tool before saving it — this does NOT save anything by itself. Call it as soon as there\'s enough to render a sensible preview (a template + name is usually enough on its own); don\'t ask "should I set this up?" in chat text first — the Create button on the preview card is the only confirmation, so asking again in words makes them confirm twice. Only ask a real question when something required is missing or genuinely ambiguous — never interrogate for optional specifics nobody brought up, and never invent a target/goal number, a unit, or an extra field the user didn\'t actually mention. If the user asks for a change before tapping Create, call this again with the revision for a fresh preview.',
    input_schema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: TOOL_TEMPLATES_ENUM,
          description:
            'workout: exercise/sets/reps/weight log. habit: a daily/weekly check-in with a streak. numeric: track a single number over time (pages read, weight, anything countable) toward an optional total. money: track contributions toward a savings/spending goal. journal: freeform entries with an optional rating — for things with no natural number.',
        },
        name: { type: 'string', description: 'Short name for the tracker, e.g. "Savings for Berlin".' },
        icon: { type: 'string', enum: ICON_ENUM, description: 'Pick whichever best matches what this tracks.' },
        unit: {
          type: 'string',
          description:
            'Unit for the tracked number, e.g. "lb", "kg", "pages", "min" — only if the user actually said one.',
        },
        currency: {
          type: 'string',
          description: 'Currency symbol for a money tracker, e.g. "$" — only for template=money.',
        },
        targetValue: {
          type: 'number',
          description:
            'The target/goal amount, only if the user actually gave one (e.g. "$2,000", "3 times a week"). Never invent a number they did not say — omit this entirely rather than guess, and a tool without a target is completely fine.',
        },
        targetPeriod: {
          type: 'string',
          enum: ['day', 'week'],
          description: 'Only with a targetValue on workout/habit templates — how often the target resets.',
        },
        extraFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              type: { type: 'string', enum: TOOL_FIELD_TYPES_ENUM },
              unit: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, description: 'choice fields only.' },
              required: { type: 'boolean' },
            },
            required: ['label', 'type'],
          },
          description:
            'Up to 5 extra fields beyond the template defaults — only if the user specifically asked to track something extra (e.g. "and RPE").',
        },
        omitFields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Default field labels to drop, only if the user said they don\'t want them.',
        },
      },
      required: ['template', 'name'],
    },
  },
  {
    name: 'edit_tool',
    description:
      "Edit an existing tool's name, icon, target amount, unit, or fields — use the tool's ref from the tools list in context, never guess one. Only include what the user actually asked to change; never resend the whole thing. You can: rename the tool or a field, change the target number, change the unit, add new field(s) (max 5 at a time), or remove a field (its past entries keep their data — they just stop showing that field going forward). You cannot change a tool's template type or fully redesign its layout — if the user wants something structurally different, suggest creating a new tool instead of forcing it through this. Applies immediately (it's undoable, unlike create_tool's preview) — state the concrete before/after value when you confirm it.",
    input_schema: {
      type: 'object',
      properties: {
        toolRef: TOOL_REF_PROPERTY,
        nameHint: TOOL_NAME_HINT_PROPERTY,
        name: { type: 'string' },
        icon: { type: 'string', enum: ICON_ENUM },
        targetValue: {
          type: 'number',
          description: "New target/goal amount — only if this tool already has a target to change.",
        },
        unit: { type: 'string' },
        addFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              type: { type: 'string', enum: TOOL_FIELD_TYPES_ENUM },
              unit: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              required: { type: 'boolean' },
            },
            required: ['label', 'type'],
          },
        },
        removeFieldRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field refs to remove, e.g. ["L1.3"] — from that tool\'s [fields: ...] list in context.',
        },
        renameFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { fieldRef: { type: 'string' }, label: { type: 'string' } },
            required: ['fieldRef', 'label'],
          },
        },
      },
      required: ['toolRef', 'nameHint'],
    },
  },
  {
    name: 'log_tool_entry',
    description:
      'Log an explicit entry to an existing tool the user just told you about — e.g. "log $150 to savings", "did 3 sets of 10 at 135lb". Only for a value the user actually stated; never invent a missing required field — ask instead. Use the tool\'s ref and its field refs exactly as shown in the tools list in context, e.g. toolRef "L1", fieldRef "L1.1".',
    input_schema: {
      type: 'object',
      properties: {
        toolRef: TOOL_REF_PROPERTY,
        nameHint: TOOL_NAME_HINT_PROPERTY,
        values: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fieldRef: {
                type: 'string',
                description: 'A field ref from that tool\'s [fields: ...] list, e.g. "L1.1" — never a guess.',
              },
              value: { description: 'The value for that field — a number, text, true/false, or (rating) 1-5.' },
            },
            required: ['fieldRef', 'value'],
          },
          description: 'Every field value the user actually gave — omit fields they did not mention.',
        },
        entryAt: {
          type: 'string',
          description:
            'Optional — only set if the user specified a different time than now (e.g. "log yesterday\'s run").',
        },
      },
      required: ['toolRef', 'nameHint', 'values'],
    },
  },
  {
    name: 'undo_last_action',
    description:
      'Reverse the most recent action (a task create/complete/edit/postpone/remove, or a tool create/edit/entry) across chat, the Tasks tab, and the Tools tab. Call this when the user says something like "undo that" or "undo the last thing".',
    input_schema: { type: 'object', properties: {} },
  },
];

// Same tools, wrapped in the shape OpenAI's Chat Completions API wants — the
// input_schema JSON Schemas are already standard JSON Schema, so this is a
// pure reshape with no semantic change from AI_TOOLS.
export const OPENAI_AI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = AI_TOOLS.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));

// taskRef: a turn-scoped alias ("T2"), never a raw database id — resolved
// server-side against the current TurnRefs map (lib/ai/actions.ts) before
// anything executes, so a hallucinated or out-of-range ref is rejected
// deterministically rather than trusted as a real id. titleHint is the
// secondary check: the task's title as the model understands it from
// context, verified against the resolved task's actual current title.
const taskRefSchema = z.object({
  taskRef: z.string().regex(/^T\d+$/, 'must be a task ref like "T2", not a database id'),
  titleHint: z.string().min(1),
});

const itemRefSchema = z
  .string()
  .regex(/^T\d+\.\d+$/, 'must be a checklist item ref like "T2.1", not a database id');

const scopeSchema = z.enum(['occurrence', 'series']).optional();

const progressTaskToolSchema = z.discriminatedUnion('action', [
  taskRefSchema.extend({ action: z.literal('start_timer') }),
  taskRefSchema.extend({ action: z.literal('stop_timer') }),
  taskRefSchema.extend({ action: z.literal('add_to_counter'), amount: z.number() }),
]);

const removeTasksItemSchema = z.object({ taskRef: z.string().regex(/^T\d+$/), titleHint: z.string().min(1) });

// toolRef: a turn-scoped alias ("L2"), never a raw database id — same
// resolve-then-verify pattern as taskRefSchema above, just against
// lib/ai/tool-context.ts's tool refs instead of task refs.
const toolRefSchema = z.object({
  toolRef: z.string().regex(/^L\d+$/, 'must be a tool ref like "L2", not a database id'),
  nameHint: z.string().min(1),
});

const toolFieldRefSchema = z
  .string()
  .regex(/^L\d+\.\d+$/, 'must be a field ref like "L1.1", not a database id');

const editToolToolSchema = toolRefSchema.extend({
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().max(40).optional(),
  targetValue: z.number().min(0.0001).optional(),
  unit: z.string().trim().max(20).optional(),
  addFields: z.array(toolFieldInputSchema).max(5).optional(),
  removeFieldRefs: z.array(toolFieldRefSchema).max(20).optional(),
  renameFields: z.array(z.object({ fieldRef: toolFieldRefSchema, label: z.string().trim().min(1).max(60) })).max(20).optional(),
});

const logToolEntryToolSchema = toolRefSchema.extend({
  values: z
    .array(z.object({ fieldRef: toolFieldRefSchema, value: z.union([z.number(), z.string(), z.boolean()]) }))
    .min(1)
    .max(20),
  entryAt: z.string().optional(),
});

export const AI_TOOL_SCHEMAS = {
  create_task: createTaskInputSchema,
  edit_task: taskRefSchema.merge(editTaskPatchSchema),
  complete_task: taskRefSchema.extend({
    value: z.number().optional(),
    itemRefs: z.array(itemRefSchema).optional(),
  }),
  progress_task: progressTaskToolSchema,
  postpone_task: taskRefSchema.merge(postponeInputSchema),
  remove_task: taskRefSchema.extend({ scope: scopeSchema }),
  remove_tasks: z.object({ items: z.array(removeTasksItemSchema).min(1).max(50), scope: scopeSchema }),
  create_tool: createToolParamsSchema,
  edit_tool: editToolToolSchema,
  log_tool_entry: logToolEntryToolSchema,
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
