import { z } from 'zod';

// Five-type model from CLAUDE.md / phase-3-tasks.md (numeric_meter was
// dropped — functionally identical to counter, just an unnecessary second
// type). `recurring` is not a standalone type — a template row keeps its
// base type (a daily counter is still a counter each day) and carries a
// non-null `recurrence` instead. The DB check constraint still allows the
// literal 'recurring' and 'numeric_meter' values for backwards compatibility
// with the column shape, but nothing writes them.
export const TASK_TYPES = ['completion', 'checklist', 'counter', 'duration'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ['open', 'done', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24h, local)');

// The AI naturally emits wall-clock datetimes with no timezone designator
// (e.g. "2026-07-12T07:00:00" for "7am"), which zod's strict `.datetime()`
// (UTC-only by default) rejects. This accepts anything `Date.parse` can
// read; the AI action layer (lib/ai/actions.ts) is responsible for
// normalizing an offset-less string to a real UTC instant using the user's
// timezone *before* it reaches the executor — this schema only guards
// against structurally invalid input.
const dueAtSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a valid datetime');

// --- recurrence -------------------------------------------------------
export const recurrenceSchema = z.discriminatedUnion('freq', [
  z.object({ freq: z.literal('daily'), time: timeSchema.optional() }),
  z.object({
    freq: z.literal('weekly'),
    byWeekday: z.array(z.enum(WEEKDAYS)).min(1),
    time: timeSchema.optional(),
  }),
  z.object({
    freq: z.literal('every_n_days'),
    n: z.number().int().min(2).max(365),
    time: timeSchema.optional(),
  }),
]);
export type Recurrence = z.infer<typeof recurrenceSchema>;

// --- per-type config ---------------------------------------------------
export const checklistItemSchema = z.object({
  id: z.string(),
  text: z.string().trim().min(1).max(200),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

// `reminder`/`dueTimeExplicit` are cross-type flags stored alongside each
// type's own fields (matching `tasks.dueAt`'s reach — whether it was a real
// user/AI-specified clock time vs. the server's end-of-day default).
const crossTypeConfigFields = {
  reminder: z.boolean().optional(),
  dueTimeExplicit: z.boolean().optional(),
};

export const completionConfigSchema = z
  .object({ note: z.string().max(500).optional(), ...crossTypeConfigFields })
  .strict();
export const checklistConfigSchema = z
  .object({ items: z.array(checklistItemSchema).min(1).max(30), ...crossTypeConfigFields })
  .strict();
export const counterConfigSchema = z
  .object({
    count: z.number().min(0),
    target: z.number().min(1),
    unit: z.string().trim().max(20).optional(),
    ...crossTypeConfigFields,
  })
  .strict();
export const durationConfigSchema = z
  .object({
    loggedMinutes: z.number().min(0),
    targetMinutes: z.number().min(1),
    runningSince: z.string().datetime().nullable().optional(),
    ...crossTypeConfigFields,
  })
  .strict();

export const taskConfigSchemaByType = {
  completion: completionConfigSchema,
  checklist: checklistConfigSchema,
  counter: counterConfigSchema,
  duration: durationConfigSchema,
} as const;

export type CompletionConfig = z.infer<typeof completionConfigSchema>;
export type ChecklistConfig = z.infer<typeof checklistConfigSchema>;
export type CounterConfig = z.infer<typeof counterConfigSchema>;
export type DurationConfig = z.infer<typeof durationConfigSchema>;
export type TaskConfig = CompletionConfig | ChecklistConfig | CounterConfig | DurationConfig;

// --- create input --------------------------------------------------------
// Flat, type-discriminated shape shared by the REST route and the AI tool —
// both hand this the same JSON and get the same validation + defaulting.
const sharedCreateFields = {
  title: z.string().trim().min(1).max(200),
  icon: z.string().trim().max(40).optional(),
  dueAt: dueAtSchema.optional(),
  note: z.string().max(500).optional(),
  recurrence: recurrenceSchema.optional(),
  reminder: z.boolean().optional(),
  // Internal-only — never exposed in the AI tool's JSON schema (the model
  // can't set it). The AI action layer sets this explicitly: true when the
  // model gave a real time, false when the server defaulted dueAt to
  // end-of-day because none was given. The UI form always passes true
  // implicitly (createTask defaults to true when omitted).
  dueTimeExplicit: z.boolean().optional(),
};

export const createTaskInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('completion'), ...sharedCreateFields }),
  z.object({
    type: z.literal('checklist'),
    ...sharedCreateFields,
    items: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  }),
  z.object({
    type: z.literal('counter'),
    ...sharedCreateFields,
    target: z.number().min(1),
    unit: z.string().trim().max(20).optional(),
  }),
  z.object({
    type: z.literal('duration'),
    ...sharedCreateFields,
    targetMinutes: z.number().min(1),
  }),
]);
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export function buildInitialConfig(input: CreateTaskInput): TaskConfig {
  switch (input.type) {
    case 'completion':
      return { note: input.note };
    case 'checklist':
      return { items: input.items.map((text) => ({ id: crypto.randomUUID(), text, done: false })) };
    case 'counter':
      return { count: 0, target: input.target, unit: input.unit };
    case 'duration':
      return { loggedMinutes: 0, targetMinutes: input.targetMinutes, runningSince: null };
  }
}

// --- edit patch ----------------------------------------------------------
// Superset of every type's editable fields; the executor rejects keys that
// don't apply to the task's actual type rather than silently ignoring them.
export const editTaskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    icon: z.string().trim().max(40).nullable().optional(),
    dueAt: dueAtSchema.nullable().optional(),
    note: z.string().max(500).optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    reminder: z.boolean().optional(),
    // checklist: replaces the item list; new items start undone, items whose
    // text is unchanged keep their done state.
    items: z.array(z.string().trim().min(1).max(200)).min(1).max(30).optional(),
    // counter
    target: z.number().min(0.0001).optional(),
    unit: z.string().trim().max(20).optional(),
    // duration
    targetMinutes: z.number().min(1).optional(),
  })
  .strict();
export type EditTaskPatch = z.infer<typeof editTaskPatchSchema>;

const EDIT_KEYS_BY_TYPE: Record<TaskType, ReadonlyArray<keyof EditTaskPatch>> = {
  completion: ['title', 'icon', 'dueAt', 'note', 'recurrence', 'reminder'],
  checklist: ['title', 'icon', 'dueAt', 'recurrence', 'items', 'reminder'],
  counter: ['title', 'icon', 'dueAt', 'recurrence', 'target', 'unit', 'reminder'],
  duration: ['title', 'icon', 'dueAt', 'recurrence', 'targetMinutes', 'reminder'],
};

export function validateEditPatchForType(type: TaskType, patch: EditTaskPatch): string | null {
  const allowed = new Set(EDIT_KEYS_BY_TYPE[type]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key as keyof EditTaskPatch)) {
      return `"${key}" cannot be edited on a ${type} task`;
    }
  }
  return null;
}

// --- progress ------------------------------------------------------------
// Fine-grained progress actions (the "+1" button, timer start/stop, a
// checklist item tap) — one `records` row per call, each independently
// undoable. `complete_task` (REST + AI) resolves to one of these under the
// hood (see lib/tasks/progress.ts).
export const progressInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mark_done') }),
  z.object({ kind: z.literal('mark_open') }),
  z.object({ kind: z.literal('checklist_toggle'), itemId: z.string() }),
  z.object({ kind: z.literal('checklist_complete'), itemIds: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('counter_increment'), amount: z.number().int().optional() }),
  z.object({ kind: z.literal('counter_set'), count: z.number().min(0) }),
  z.object({ kind: z.literal('duration_start') }),
  z.object({ kind: z.literal('duration_stop') }),
  z.object({ kind: z.literal('duration_add_minutes'), minutes: z.number().min(1) }),
  z.object({ kind: z.literal('duration_set_minutes'), minutes: z.number().min(0) }),
  z.object({ kind: z.literal('reopen') }),
]);
export type ProgressInput = z.infer<typeof progressInputSchema>;

export const postponeInputSchema = z.object({
  newDueAt: dueAtSchema.nullable(),
  reason: z.enum(['bad_timing', 'low_energy', 'avoided']).nullable().optional(),
});
export type PostponeInput = z.infer<typeof postponeInputSchema>;
