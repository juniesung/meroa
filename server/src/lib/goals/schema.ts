import { z } from 'zod';

// A tool = typed fields + an optional target + 1-3 progress views, stored in
// tools.definition (jsonb). Fields carry a stable id (crypto.randomUUID(),
// never re-derived from label) so entries keep referencing the right column
// across renames, archival, and re-ordering — see templates.ts and
// docs/phase-4-implementation-plan.md §1.1.
export const GOAL_FIELD_TYPES = ['number', 'text', 'boolean', 'rating', 'choice'] as const;
export type GoalFieldType = (typeof GOAL_FIELD_TYPES)[number];

export const goalFieldSchema = z
  .object({
    id: z.string(),
    label: z.string().trim().min(1).max(60),
    type: z.enum(GOAL_FIELD_TYPES),
    unit: z.string().trim().max(20).optional(),
    // choice fields only.
    options: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
    required: z.boolean().optional(),
    // Removed fields are archived, never deleted — old entries keep their
    // data forever (CLAUDE.md §2's "past records survive layout changes").
    // Archived fields never render in the AI's tool context and never
    // accept new entry values.
    archived: z.boolean().optional(),
  })
  .strict();
export type GoalField = z.infer<typeof goalFieldSchema>;

// Input shape for a new field (create-time template params, or edit_tool's
// addFields) — same as GoalField minus `id`/`archived`, which the server
// assigns.
export const goalFieldInputSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    type: z.enum(GOAL_FIELD_TYPES),
    unit: z.string().trim().max(20).optional(),
    options: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
    required: z.boolean().optional(),
  })
  .strict();
export type GoalFieldInput = z.infer<typeof goalFieldInputSchema>;

export const goalTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('total'), value: z.number().min(0.0001), unit: z.string().trim().max(20).optional() }),
  z.object({ kind: z.literal('count_per_period'), period: z.enum(['day', 'week']), value: z.number().min(1) }),
]);
export type GoalTarget = z.infer<typeof goalTargetSchema>;

export const goalViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress_total') }),
  z.object({ kind: z.literal('streak') }),
  z.object({
    kind: z.literal('bars'),
    bucket: z.enum(['day', 'week']),
    measure: z.enum(['count', 'sum']),
    // Required when measure is 'sum' (which field to sum) — validated in
    // goalDefinitionSchema's refine below, not the discriminated union
    // itself, since it's a cross-field constraint.
    fieldId: z.string().optional(),
  }),
  z.object({ kind: z.literal('recent_list') }),
]);
export type GoalView = z.infer<typeof goalViewSchema>;

export const goalDefinitionSchema = z
  .object({
    fields: z.array(goalFieldSchema).min(1).max(20),
    // The numeric field summed for a 'total' target / a 'sum' bars view
    // (money's Amount, numeric's Value). Optional — workout/habit/journal
    // have no single summable field.
    primaryFieldId: z.string().optional(),
    target: goalTargetSchema.optional(),
    views: z.array(goalViewSchema).min(1).max(3),
    // "session", "contribution", "entry" — used in generated copy.
    entryNoun: z.string().trim().max(30).optional(),
  })
  .strict()
  .refine(
    (def) => def.views.every((v) => v.kind !== 'bars' || v.measure !== 'sum' || !!v.fieldId),
    { message: 'a bars view with measure "sum" needs fieldId' },
  );
export type GoalDefinition = z.infer<typeof goalDefinitionSchema>;

export const GOAL_TEMPLATES = ['workout', 'habit', 'numeric', 'money', 'journal'] as const;
export type GoalTemplateKey = (typeof GOAL_TEMPLATES)[number];

// What create_goal actually returns to the model and stores on the preview
// message's meta — never a saved tools row (phase-4-implementation-plan.md
// §1.3). routes/goals.ts's POST / (the Create-tap confirm) re-validates and
// saves exactly this shape.
export type GoalPreview = {
  template: GoalTemplateKey;
  name: string;
  icon: string | null;
  definition: GoalDefinition;
};

// --- create ----------------------------------------------------------
// Flat, template-discriminated params — the server (templates.ts) assembles
// the full GoalDefinition from these; the model never emits a raw field
// array for the default shape (phase-4-implementation-plan.md §1.2).
export const createGoalParamsSchema = z
  .object({
    template: z.enum(GOAL_TEMPLATES),
    name: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(40).optional(),
    unit: z.string().trim().max(20).optional(),
    currency: z.string().trim().max(6).optional(),
    targetValue: z.number().min(0.0001).optional(),
    targetPeriod: z.enum(['day', 'week']).optional(),
    // Bounded customization at create time — never a full field array.
    extraFields: z.array(goalFieldInputSchema).max(5).optional(),
    // Default-field labels to drop (e.g. "Notes" on a workout tracker).
    omitFields: z.array(z.string().trim()).max(10).optional(),
  })
  .strict();
export type CreateGoalParams = z.infer<typeof createGoalParamsSchema>;

// --- edit (constrained ops, never a full-definition resend) ------------
// Executor-level shape uses real field ids; the AI tool layer (lib/ai/
// tools.ts, lib/ai/actions.ts) resolves fieldRef -> fieldId before this ever
// runs — see docs/ai-reliability-hardening.md lesson 13: an edit surface
// must never resave a value it can't faithfully represent, so this only
// ever carries fields the caller actually touched.
export const editGoalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().max(40).optional(),
    // Updates target.value in place, keeping the existing kind/period/unit.
    // Clearing a target entirely isn't exposed yet — no observed need.
    targetValue: z.number().min(0.0001).optional(),
    // Updates the primary field's unit (and target.unit for a 'total' target).
    unit: z.string().trim().max(20).optional(),
    addFields: z.array(goalFieldInputSchema).max(5).optional(),
    removeFieldIds: z.array(z.string()).max(20).optional(),
    renameFields: z.array(z.object({ fieldId: z.string(), label: z.string().trim().min(1).max(60) })).max(20).optional(),
  })
  .strict();
export type EditGoalPatch = z.infer<typeof editGoalPatchSchema>;

// --- entries -----------------------------------------------------------
export const goalEntryValueSchema = z.object({
  fieldId: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]),
});
export type GoalEntryValue = z.infer<typeof goalEntryValueSchema>;

export const logGoalEntryPatchSchema = z
  .object({
    values: z.array(goalEntryValueSchema).min(1).max(20),
    // Optional ISO/local datetime — omit for "now". Normalized through
    // localDatetimeToUtcIso (lib/tasks/recurrence.ts) before it reaches the
    // executor, same as every other AI-supplied datetime.
    entryAt: z.string().optional(),
  })
  .strict();
export type LogGoalEntryPatch = z.infer<typeof logGoalEntryPatchSchema>;

/**
 * Validates a set of entry values against the tool's current (non-archived)
 * fields: every field's type is checked, required fields must be present,
 * and unknown/archived field ids are rejected. Returns the first error
 * found, or null if everything checks out. Never invents a missing
 * required value (CLAUDE.md §2) — the caller turns this into an
 * ask-the-user error rather than defaulting anything.
 */
export function validateEntryValues(
  fields: GoalField[],
  values: GoalEntryValue[],
): string | null {
  const byId = new Map(fields.filter((f) => !f.archived).map((f) => [f.id, f]));
  const provided = new Set<string>();

  for (const v of values) {
    const field = byId.get(v.fieldId);
    if (!field) return `field ${v.fieldId} doesn't exist or is archived`;
    provided.add(field.id);
    const typeError = checkValueType(field, v.value);
    if (typeError) return typeError;
  }

  for (const field of byId.values()) {
    if (field.required && !provided.has(field.id)) {
      return `"${field.label}" is required — ask the user for it rather than guessing`;
    }
  }

  return null;
}

function checkValueType(field: GoalField, value: GoalEntryValue['value']): string | null {
  switch (field.type) {
    case 'number':
      return typeof value === 'number' ? null : `"${field.label}" needs a number`;
    case 'rating': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
        return `"${field.label}" needs a rating from 1 to 5`;
      }
      return null;
    }
    case 'text':
      return typeof value === 'string' ? null : `"${field.label}" needs text`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${field.label}" needs true/false`;
    case 'choice': {
      if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
        return `"${field.label}" must be one of: ${(field.options ?? []).join(', ')}`;
      }
      return null;
    }
  }
}
