import { z } from 'zod';

// v1 ships exactly one goal type — savings (docs/goals-redesign-plan.md §1,
// §2.2). Habit/indirect/milestone join this list one at a time in later
// passes; goals.template (the DB column) stays the discriminator tag,
// mirrored inside the definition's own `type` field so a future
// discriminated union across types doesn't need a shape change here.
export const GOAL_TEMPLATES = ['savings'] as const;
export type GoalTemplateKey = (typeof GOAL_TEMPLATES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A goal = a real number + an optional target deadline + completing linked
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

// Becomes a real z.discriminatedUnion('type', [...]) once goal type 2
// (habit) lands; a single-variant alias avoids the extra indirection until
// there's a second variant to discriminate against.
export const goalDefinitionSchema = savingsGoalDefinitionSchema;
export type GoalDefinition = SavingsGoalDefinition;

// What create_goal returns to the model and stores on the preview message's
// meta — never a saved goals row (docs/goals-redesign-plan.md §2.1).
// routes/goals.ts's POST / (the Create-tap confirm) re-validates and saves
// exactly this shape.
export type GoalPreview = {
  template: GoalTemplateKey;
  name: string;
  icon: string | null;
  definition: GoalDefinition;
};

// --- create ----------------------------------------------------------
// The model never sends `template` (v1 only has 'savings' — the executor
// stamps it) or `checkInCadence` (Phase 6). Flat params only.
export const createGoalParamsSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(40).optional(),
    currency: z.string().trim().min(1).max(6).optional(),
    targetValue: z.number().min(0.01),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
  })
  .strict();
export type CreateGoalParams = z.infer<typeof createGoalParamsSchema>;

// --- edit (constrained ops, never a full-definition resend) ------------
// v1 ops: name, icon, targetValue, deadline — nothing else exists to edit
// yet (docs/goals-redesign-plan.md §2.2).
export const editGoalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().max(40).optional(),
    targetValue: z.number().min(0.01).optional(),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
  })
  .strict();
export type EditGoalPatch = z.infer<typeof editGoalPatchSchema>;

// --- entries -----------------------------------------------------------
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
