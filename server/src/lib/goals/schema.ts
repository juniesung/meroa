import { z } from 'zod';

import { recurrenceSchema } from '../tasks/schema.ts';

// Goal types ship one at a time (docs/goals-redesign-plan.md §1): savings
// first, habit second (this one), indirect + milestone deferred to their
// own passes. goals.template (the DB column) is the discriminator tag,
// mirrored inside the definition's own `type` field.
export const GOAL_TEMPLATES = ['savings', 'habit'] as const;
export type GoalTemplateKey = (typeof GOAL_TEMPLATES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Savings = a real number + an optional target deadline + completing linked
// tasks logs against it (docs/goals-redesign-plan.md §2.2). The old generic
// fields/views/field-ref machinery (Phase 4's Tools) is deleted, not
// ported — each goal type gets its own literal definition + entry shape
// instead of a shared field-builder, which was the main bug surface and
// served no user need.
export const savingsGoalDefinitionSchema = z
  .object({
    type: z.literal('savings'),
    currency: z.string().trim().min(1).max(6),
    targetValue: z.number().min(0.01),
    // ISO date ("YYYY-MM-DD") — the model converts relative language
    // ("in 30 days") to a concrete date using today's date from context
    // before calling create_goal/edit_goal; this schema only accepts the
    // resolved form.
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
    // Stored now, acted on in Phase 6 once quiet-hours/frequency guardrails
    // exist — never set by the model today (docs/goals-redesign-plan.md §1).
    checkInCadence: z.enum(['weekly', 'off']).optional(),
  })
  .strict();
export type SavingsGoalDefinition = z.infer<typeof savingsGoalDefinitionSchema>;

// Habit = no target number at all; a linked daily task + a streak is the
// whole mechanic (docs/goals-redesign-plan.md §1). Missing a day genuinely
// resets the streak — `longest` is always kept and shown; the copy stays
// warm, the reset is mechanically real. The definition carries nothing but
// the tag: all state lives in the linked task's completions, read through
// the consistency engine scoped to this goal's own task
// (lib/goals/consistency.ts's taskIdFilter — built for exactly this).
// Habit goals have NO goal_entries — the task completions ARE the record.
export const habitGoalDefinitionSchema = z
  .object({
    type: z.literal('habit'),
    checkInCadence: z.enum(['weekly', 'off']).optional(),
  })
  .strict();
export type HabitGoalDefinition = z.infer<typeof habitGoalDefinitionSchema>;

export const goalDefinitionSchema = z.discriminatedUnion('type', [
  savingsGoalDefinitionSchema,
  habitGoalDefinitionSchema,
]);
export type GoalDefinition = z.infer<typeof goalDefinitionSchema>;

// A starter task proposed alongside the goal. For savings, `contribution`
// is the amount completing it auto-logs (docs/goals-redesign-plan.md §2.3);
// for habit there's no amount — the completion itself is the check-in, so
// contribution stays unset (the auto-entry hook requires a numeric
// contribution and correctly logs nothing without one).
export const starterTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    recurrence: recurrenceSchema.optional(),
    contribution: z.number().min(0.01).optional(),
  })
  .strict();
export type StarterTask = z.infer<typeof starterTaskSchema>;

// What create_goal returns to the model and stores on the preview message's
// meta — never a saved goals row (docs/goals-redesign-plan.md §2.1).
// routes/goals.ts's POST / (the Create-tap confirm) re-validates and saves
// exactly this shape, creating the goal and every starter task in one
// transaction.
export type GoalPreview = {
  template: GoalTemplateKey;
  name: string;
  icon: string | null;
  definition: GoalDefinition;
  starterTasks?: StarterTask[];
};

// --- create ----------------------------------------------------------
// Flat params; `type` picks the goal shape and the cross-field rules are
// enforced in the superRefine below rather than trusted to the model:
// savings needs a target amount; habit needs no numbers at all but MUST
// come with its recurring check-in task (it's the whole mechanic — a habit
// goal without one could never progress).
export const createGoalParamsSchema = z
  .object({
    type: z.enum(['savings', 'habit']).default('savings'),
    name: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(40).optional(),
    currency: z.string().trim().min(1).max(6).optional(),
    targetValue: z.number().min(0.01).optional(),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
    starterTasks: z.array(starterTaskSchema).max(5).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.type === 'savings') {
      if (params.targetValue === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetValue'],
          message: 'a savings goal needs a target amount — ask the user for it rather than guessing',
        });
      }
      return;
    }
    // habit
    if (params.targetValue !== undefined || params.currency !== undefined || params.deadline !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: 'a habit goal has no target amount, currency, or deadline — the daily task + streak is the whole mechanic; omit those fields',
      });
    }
    if (!params.starterTasks?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterTasks'],
        message: 'a habit goal needs its recurring check-in task (e.g. a daily "Meditate 10 min") in starterTasks — the streak counts that task',
      });
    } else if (!params.starterTasks[0]?.recurrence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterTasks'],
        message: "a habit's check-in task must repeat (recurrence, usually daily) — a one-off task can't carry a streak",
      });
    } else if (params.starterTasks.some((s) => s.contribution !== undefined)) {
      // A contribution would make completions write goal_entries — but a
      // habit goal has none by definition (the completions ARE the record),
      // so reject here rather than silently corrupting that invariant.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterTasks'],
        message: 'a habit check-in task has no contribution amount — completing it IS the check-in; omit contribution',
      });
    }
  });
export type CreateGoalParams = z.infer<typeof createGoalParamsSchema>;

// --- edit (constrained ops, never a full-definition resend) ------------
// Ops: name, icon for every type; targetValue, deadline for savings only
// (enforced against the goal's actual type in the executor's applyEditOps,
// not here — the patch shape can't know the type).
export const editGoalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().max(40).optional(),
    targetValue: z.number().min(0.01).optional(),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
  })
  .strict();
export type EditGoalPatch = z.infer<typeof editGoalPatchSchema>;

// --- entries (savings only — habit goals have no entries) ---------------
// Fixed shape, no field ids — goal_entries.data = { amount, note? }
// (docs/goals-redesign-plan.md §2.2).
export const logGoalEntryPatchSchema = z
  .object({
    amount: z.number(),
    note: z.string().trim().max(200).optional(),
    // Optional ISO/local datetime — omit for "now". Normalized through
    // localDatetimeToUtcIso (lib/tasks/recurrence.ts) before it reaches the
    // executor, same as every other AI-supplied datetime.
    entryAt: z.string().optional(),
  })
  .strict();
export type LogGoalEntryPatch = z.infer<typeof logGoalEntryPatchSchema>;

export const goalEntryDataSchema = z.object({
  amount: z.number(),
  note: z.string().trim().max(200).optional(),
});
export type GoalEntryData = z.infer<typeof goalEntryDataSchema>;
