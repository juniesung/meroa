import { z } from 'zod';

import { recurrenceSchema } from '../tasks/schema.ts';

// Goal types ship one at a time (docs/goals-redesign-plan.md §1): savings
// first, habit second, indirect third, milestone fourth and last (this
// one) — the type system is complete after this. goals.template (the DB
// column) is the discriminator tag, mirrored inside the definition's own
// `type` field.
export const GOAL_TEMPLATES = ['savings', 'habit', 'indirect', 'milestone'] as const;
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

// Indirect = real measurements logged explicitly get their own chart;
// linked tasks are supporting activity only — no progress bar or number is
// ever derived from a task for this type (docs/goals-redesign-plan.md §1.3,
// locked with the user: "no progress bar derived from tasks, ever"). Unlike
// savings, targetValue is optional — "track my weight" with just a unit is
// a complete goal on its own; a target/deadline unlock the pace line once
// stated. There's no stored "starting value" or direction field: the first
// logged entry (chronologically) IS the starting point, and progress is
// derived from start vs. target vs. current (lib/goals/summary.ts), so it
// works whether the user is going up (savings-like) or down (weight loss).
// No .superRefine() here (unlike a plain z.object, that would wrap this in
// a ZodEffects, which z.discriminatedUnion below can't accept as a member)
// — the deadline-needs-a-target cross-field rule lives in
// createGoalParamsSchema's superRefine (creation) and applyEditOps
// (lib/goals/executor.ts, edits) instead.
export const indirectGoalDefinitionSchema = z
  .object({
    type: z.literal('indirect'),
    // e.g. "lb", "kg", "pages" — required even with no target, so every
    // logged number has units the moment it's shown.
    unit: z.string().trim().min(1).max(20),
    targetValue: z.number().optional(),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
    checkInCadence: z.enum(['weekly', 'off']).optional(),
  })
  .strict();
export type IndirectGoalDefinition = z.infer<typeof indirectGoalDefinitionSchema>;

// A task planned for a stage that hasn't activated yet (docs/goal-manual-
// editing-plan.md §2) — the same shape as a starter task minus
// `contribution` (a planned task never logs a number; a milestone goal has
// none). It is not a task row and never rendered on the Tasks tab; it only
// becomes one when `advanceGoalStage` materializes it (lib/goals/
// executor.ts).
export const plannedTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    recurrence: recurrenceSchema.optional(),
    icon: z.string().trim().max(40).optional(),
  })
  .strict();
export type PlannedTask = z.infer<typeof plannedTaskSchema>;

// Milestone = ordered stages, one active at a time, advanced only on the
// user's explicit say-so — never automatically, never because a linked
// task completed (docs/milestone-goal-plan.md §1.4, locked). No numbers
// anywhere: progress is stagesDone / stagesTotal, derived from
// activeStageIndex, legitimate because every advance was user-declared.
// `stages` is a fixed literal string array — no per-stage ids in v1,
// nothing references a stage by identity yet. `activeStageIndex ===
// stages.length` means every stage is done (the goal is complete); the
// upper bound (<= stages.length) is enforced in createGoalParamsSchema and
// applyEditOps wherever the definition is rebuilt, same reason the
// deadline-needs-a-target rule for indirect lives outside this schema.
//
// `stages` has no `.min(2)` here (docs/goal-manual-editing-plan.md §1
// decision 1): a bare "goal to land an internship" with no stated
// milestones stores `stages: []` — a name-only template the user fills in
// via the Goals tab, never a stage chat invents. The "0, or 2-8, never
// exactly 1" invariant is enforced by every writer (buildGoalDefinition,
// applyStageOps below) instead of this schema, for the same ZodEffects-
// can't-be-a-union-member reason indirect's cross-field rules live outside
// their own schema.
//
// `stagePlans[i]` is that stage's planned tasks, index-aligned with
// `stages` — populated only for `i > activeStageIndex` (a plan for the
// active or a completed stage would blur "intention" with "real task",
// which is the one distinction this app must never blur). Absent/omitted
// means no plans yet, which is true for every goal before this feature and
// needs no migration.
export const milestoneGoalDefinitionSchema = z
  .object({
    type: z.literal('milestone'),
    stages: z.array(z.string().trim().min(1).max(60)).max(8),
    activeStageIndex: z.number().int().min(0),
    stagePlans: z.array(z.array(plannedTaskSchema).max(5)).max(8).optional(),
    checkInCadence: z.enum(['weekly', 'off']).optional(),
  })
  .strict();
export type MilestoneGoalDefinition = z.infer<typeof milestoneGoalDefinitionSchema>;

export const goalDefinitionSchema = z.discriminatedUnion('type', [
  savingsGoalDefinitionSchema,
  habitGoalDefinitionSchema,
  indirectGoalDefinitionSchema,
  milestoneGoalDefinitionSchema,
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
// Flat params shared by the chat create_goal tool AND the manual create
// route (docs/goal-manual-editing-plan.md §1) — one base shape, `type`
// picks the goal shape, and the cross-field rules are enforced in the
// refine function below rather than trusted to the caller: savings needs a
// target amount; habit needs no numbers at all but MUST come with its
// recurring check-in task (it's the whole mechanic — a habit goal without
// one could never progress). `.strict()` and `.superRefine()` are applied
// per-caller below (createGoalParamsSchema for chat, manualCreateGoalSchema
// for the manual route, which additionally accepts `stagePlans`) rather
// than on this base, so both can extend it independently.
const createGoalParamsBaseSchema = z.object({
  type: z.enum(['savings', 'habit', 'indirect', 'milestone']).default('savings'),
  name: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(40).optional(),
  currency: z.string().trim().min(1).max(6).optional(),
  targetValue: z.number().min(0.01).optional(),
  deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
  // indirect only.
  unit: z.string().trim().min(1).max(20).optional(),
  // milestone only — ordered stage titles, editable in the preview (chat)
  // or the form (manual) before Create. Omitted entirely = a bare
  // template (stored `stages: []`); when given, 2-8. activeStageIndex is
  // never a caller input — create_goal always starts a fresh milestone at
  // stage 0 (docs/milestone-goal-plan.md §1).
  stages: z.array(z.string().trim().min(1).max(60)).min(2).max(8).optional(),
  starterTasks: z.array(starterTaskSchema).max(5).optional(),
});

type CreateGoalParamsInput = z.infer<typeof createGoalParamsBaseSchema>;

// The cross-field rules, factored out so createGoalParamsSchema (chat) and
// manualCreateGoalSchema (the manual route) enforce identically — a
// manually-created goal must be exactly as valid as a chat-created one,
// never a looser cousin.
function refineCreateGoalParams(params: CreateGoalParamsInput, ctx: z.RefinementCtx) {
  if (params.type === 'savings') {
    if (params.targetValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetValue'],
        message: 'a savings goal needs a target amount — ask the user for it rather than guessing',
      });
    }
    if (params.unit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unit'],
        message: 'a savings goal has no unit field — it always uses currency',
      });
    }
    if (params.stages !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages'],
        message: 'a savings goal has no stages — that field is milestone-only',
      });
    }
    return;
  }
  if (params.type === 'habit') {
    if (params.targetValue !== undefined || params.currency !== undefined || params.deadline !== undefined || params.unit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: 'a habit goal has no target amount, currency, deadline, or unit — the daily task + streak is the whole mechanic; omit those fields',
      });
    }
    if (params.stages !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages'],
        message: 'a habit goal has no stages — that field is milestone-only',
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
        message:
          "a habit's check-in task must repeat — a one-off task can't carry a streak. Use the cadence the user described: daily, weekly with byWeekday (\"3x a week\"), or every_n_days",
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
    return;
  }
  if (params.type === 'indirect') {
    // real measurements only; a linked task is supporting activity, never
    // a source of the number itself (locked decision: "no progress bar
    // derived from tasks, ever").
    if (params.unit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unit'],
        message: 'an indirect goal needs a unit (e.g. "lb", "pages") — ask the user rather than guessing one',
      });
    }
    if (params.currency !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'an indirect goal has no currency — it tracks a measurement, not money',
      });
    }
    if (params.deadline !== undefined && params.targetValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadline'],
        message: 'a deadline only makes sense with a target value — include one or drop the deadline',
      });
    }
    if (params.stages !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages'],
        message: 'an indirect goal has no stages — that field is milestone-only',
      });
    }
    if (params.starterTasks?.some((s) => s.contribution !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterTasks'],
        message: 'an indirect goal never logs a number from a task — omit contribution; a starter task here is supporting activity only',
      });
    }
    return;
  }
  // milestone — ordered stages, no numbers anywhere (locked decision,
  // docs/milestone-goal-plan.md §0). Stages are optional: a bare "goal to
  // land an internship" with no stated milestones creates a name-only
  // template (stored `stages: []`) the user fills in later in the Goals
  // tab — chat never invents a stage sequence
  // (docs/goal-manual-editing-plan.md §1 decision 1). When given, the base
  // schema's `stages` field already requires 2-8, so the only thing left
  // to check here is that a caller can't sneak in exactly 1 by omission
  // tricks — there's no such path (undefined or a validated 2-8 array),
  // so no explicit check is needed. starterTasks, when given, are the
  // FIRST stage's tasks only; activeStageIndex always starts at 0, never a
  // caller input.
  if (
    params.targetValue !== undefined ||
    params.currency !== undefined ||
    params.deadline !== undefined ||
    params.unit !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['type'],
      message: 'a milestone goal has no target amount, currency, deadline, or unit — progress is stage N of M, not a number; omit those fields',
    });
  }
  if (params.starterTasks?.some((s) => s.contribution !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['starterTasks'],
      message: 'a milestone goal never logs a number from a task — omit contribution; starter tasks here are the current stage\'s to-dos, not a source of progress',
    });
  }
  // A bare template (no stages) has no stage 0 for starterTasks to belong
  // to yet — they're the FIRST stage's to-dos, and there's no first stage
  // until the user adds one in the Goals tab.
  if (!params.stages?.length && params.starterTasks?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['starterTasks'],
      message: 'starterTasks needs stages — omit both for a bare template, or include the stages these tasks belong to',
    });
  }
}

export const createGoalParamsSchema = createGoalParamsBaseSchema.strict().superRefine(refineCreateGoalParams);
export type CreateGoalParams = z.infer<typeof createGoalParamsSchema>;

// The manual create route's params (docs/goal-manual-editing-plan.md §1) —
// the same base + the same cross-field rules as the chat tool
// (refineCreateGoalParams), plus `stagePlans` for stages the user has
// already planned tasks for but hasn't reached yet. The model never sees
// this field — plans are a UI-only concept (§1 decision 1).
export const manualCreateGoalSchema = createGoalParamsBaseSchema
  .extend({
    stagePlans: z.array(z.array(plannedTaskSchema).max(5)).max(8).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    refineCreateGoalParams(params, ctx);
    if (params.stagePlans === undefined) return;
    if (params.type !== 'milestone') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stagePlans'],
        message: 'stagePlans is milestone-only',
      });
      return;
    }
    if (params.stagePlans.length > (params.stages?.length ?? 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stagePlans'],
        message: 'stagePlans has more entries than stages',
      });
    }
    // A fresh milestone always starts at stage 0 (activeStageIndex is
    // never a caller input) — so stage 0 is always the ACTIVE stage on
    // create, and an active stage's tasks are real tasks, never a plan
    // (docs/goal-manual-editing-plan.md §2 invariant).
    if (params.stagePlans[0]?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stagePlans'],
        message: "the first stage's tasks go in starterTasks, not stagePlans[0] — stagePlans is only for stages after the active one",
      });
    }
  });
export type ManualCreateGoalParams = z.infer<typeof manualCreateGoalSchema>;

// Pure params -> definition conversion, shared by the chat create_goal
// tool (lib/ai/actions.ts) and the manual create route (routes/goals.ts)
// so there is exactly one mapping from caller input to stored shape, ever
// (docs/goal-manual-editing-plan.md §1.4). Milestone `stages` defaults to
// `[]` (a bare template) and `activeStageIndex` is never a caller input —
// every fresh milestone starts at stage 0, chat or manual alike.
export function buildGoalDefinition(params: {
  type: GoalTemplateKey;
  currency?: string;
  targetValue?: number;
  deadline?: string;
  unit?: string;
  stages?: string[];
  stagePlans?: PlannedTask[][];
}): GoalDefinition {
  return goalDefinitionSchema.parse(
    params.type === 'habit'
      ? { type: 'habit' }
      : params.type === 'indirect'
        ? {
            type: 'indirect',
            unit: params.unit,
            targetValue: params.targetValue,
            deadline: params.deadline,
          }
        : params.type === 'milestone'
          ? {
              type: 'milestone',
              stages: params.stages ?? [],
              activeStageIndex: 0,
              ...(params.stagePlans?.length ? { stagePlans: params.stagePlans } : {}),
            }
          : {
              type: 'savings',
              currency: params.currency ?? '$',
              targetValue: params.targetValue,
              deadline: params.deadline,
            },
  );
}

// --- edit (constrained ops, never a full-definition resend) ------------
// Ops: name, icon for every type; targetValue, deadline for savings and
// indirect; unit for indirect only (enforced against the goal's actual type
// in the executor's applyEditOps, not here — the patch shape can't know the
// type). `stages`/`stagePlans` are milestone-only and routed through
// applyStageOps (below) against the goal's LIVE definition — this flat
// patch shape can't validate the completed-prefix-immutable or
// plans-alignment invariants without it (docs/goal-manual-editing-plan.md
// §2/§3.1).
export const editGoalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().max(40).optional(),
    targetValue: z.number().min(0.01).optional(),
    deadline: z.string().regex(ISO_DATE, 'deadline must be an ISO date (YYYY-MM-DD)').optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    stages: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
    stagePlans: z.array(z.array(plannedTaskSchema).max(5)).max(8).optional(),
  })
  .strict();
export type EditGoalPatch = z.infer<typeof editGoalPatchSchema>;

// Pure — the one function that mutates a milestone's `stages`/`stagePlans`
// in lockstep (docs/goal-manual-editing-plan.md §2/§3.1). Whole-list
// replacement, not a diff: the caller (the Goals-tab stage editor) sends
// the full next `stages` array, and the full next `stagePlans` if it's
// changing them too — the UI renders stage rows and their nested plans
// together, so it's the natural owner of keeping them aligned across an
// insert/delete/reorder. This function validates the result and realigns
// `stagePlans` to the new stage count.
//
// There are no per-stage ids (see milestoneGoalDefinitionSchema above), so
// "the completed prefix can't be reordered" is only checkable as "the
// completed prefix can't shrink" — a swap of two completed stages' labels
// is indistinguishable from two independent renames at the schema level.
export function applyStageOps(
  definition: MilestoneGoalDefinition,
  nextStages?: string[],
  nextPlans?: PlannedTask[][],
): { definition: MilestoneGoalDefinition } | { error: string } {
  const stages = nextStages ?? definition.stages;
  const { activeStageIndex } = definition;

  if (stages.length !== 0 && stages.length < 2) {
    return { error: 'a milestone needs at least 2 stages, or none yet (a bare template) — never exactly 1' };
  }
  if (stages.length > 8) {
    return { error: 'a milestone can have at most 8 stages' };
  }
  // A stage still in progress needs a real slot at activeStageIndex to stay
  // active (stages.length > activeStageIndex) — dropping to exactly that
  // length would silently reinterpret "stage N in progress" as "goal
  // complete". An already-complete goal (activeStageIndex === the ORIGINAL
  // stages.length) has no such stage to protect, so it only needs the count
  // itself preserved (stages.length >= activeStageIndex) — extending a
  // completed goal with new trailing stages is a permitted, if unusual, edit.
  const wasComplete = activeStageIndex >= definition.stages.length;
  const minStagesRequired = wasComplete ? activeStageIndex : activeStageIndex + 1;
  if (stages.length < minStagesRequired) {
    return {
      error: `stage ${activeStageIndex} is already active or complete — can't drop below ${minStagesRequired} stage(s)`,
    };
  }

  const source = nextPlans ?? definition.stagePlans ?? [];
  if (source.length > stages.length) {
    return { error: 'stagePlans has more entries than stages' };
  }
  for (let i = 0; i < Math.min(activeStageIndex + 1, stages.length); i++) {
    if (source[i]?.length) {
      return {
        error: `stage ${i + 1} is active or already complete — it doesn't take a plan, its tasks are real tasks`,
      };
    }
  }
  const stagePlans = stages.map((_, i) => source[i] ?? []);
  const hasAnyPlan = stagePlans.some((entry) => entry.length > 0);

  const result = milestoneGoalDefinitionSchema.safeParse({
    type: 'milestone',
    stages,
    activeStageIndex,
    ...(definition.checkInCadence !== undefined ? { checkInCadence: definition.checkInCadence } : {}),
    ...(hasAnyPlan ? { stagePlans } : {}),
  });
  if (!result.success) return { error: result.error.issues[0]?.message ?? 'invalid stage edit' };
  return { definition: result.data };
}

// --- entries (savings and indirect — habit goals have no entries) -------
// Fixed shape, no field ids — goal_entries.data = { amount, note? }
// (docs/goals-redesign-plan.md §2.2). For indirect, `amount` is the
// measurement value itself (e.g. current body weight), not a delta.
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

// --- milestone advance (pending-confirmation only, mirrors GoalPreview) ---
// Built server-side from LIVE state (lib/ai/actions.ts's advance_goal_stage
// case), never trusted from the model — stored on the confirm card
// message's meta and re-validated by POST /goals/:id/advance against
// current state before anything mutates (docs/milestone-goal-plan.md §2.1).
export type AdvanceStageProposal = {
  goalId: string;
  fromStageIndex: number;
  fromStage: string;
  // null = this advance completes the goal (there is no next stage).
  toStage: string | null;
  retire: { taskId: string; title: string }[];
  nextStageTasks?: StarterTask[];
};
