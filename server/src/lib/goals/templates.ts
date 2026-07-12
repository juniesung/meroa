import type { CreateGoalParams, GoalDefinition, GoalField, GoalFieldInput } from './schema.ts';

function field(input: GoalFieldInput): GoalField {
  return { id: crypto.randomUUID(), ...input };
}

// Extra/omit customization is bounded (max 5 extra, by-label omit) and
// applied uniformly across every template — a create-time model call gets
// small, validated deviation from the default shape, never a raw field
// array (phase-4-implementation-plan.md §1.2).
function applyCustomization(defaultFields: GoalField[], params: CreateGoalParams): GoalField[] {
  const omit = new Set((params.omitFields ?? []).map((l) => l.toLowerCase().trim()));
  const kept = defaultFields.filter((f) => !omit.has(f.label.toLowerCase().trim()));
  const extra = (params.extraFields ?? []).map(field);
  return [...kept, ...extra];
}

function workoutDefinition(params: CreateGoalParams): GoalDefinition {
  const weightUnit = params.unit ?? 'lb';
  const fields = applyCustomization(
    [
      field({ label: 'Exercise', type: 'text', required: true }),
      field({ label: 'Sets', type: 'number' }),
      field({ label: 'Reps', type: 'number' }),
      field({ label: 'Weight', type: 'number', unit: weightUnit }),
      field({ label: 'Notes', type: 'text' }),
    ],
    params,
  );
  return {
    fields,
    target: params.targetValue
      ? { kind: 'count_per_period', period: params.targetPeriod ?? 'week', value: params.targetValue }
      : undefined,
    views: [
      { kind: 'bars', bucket: 'week', measure: 'count' },
      { kind: 'recent_list' },
    ],
    entryNoun: 'session',
  };
}

function habitDefinition(params: CreateGoalParams): GoalDefinition {
  const fields = applyCustomization([field({ label: 'Notes', type: 'text' })], params);
  return {
    fields,
    target: params.targetValue
      ? { kind: 'count_per_period', period: params.targetPeriod ?? 'day', value: params.targetValue }
      : undefined,
    views: [{ kind: 'streak' }, { kind: 'bars', bucket: 'day', measure: 'count' }],
    entryNoun: 'check-in',
  };
}

function numericDefinition(params: CreateGoalParams): GoalDefinition {
  const valueField = field({ label: 'Value', type: 'number', unit: params.unit });
  const fields = applyCustomization([valueField], params);
  const views: GoalDefinition['views'] = params.targetValue
    ? [{ kind: 'progress_total' }, { kind: 'recent_list' }]
    : [
        { kind: 'bars', bucket: 'week', measure: 'sum', fieldId: valueField.id },
        { kind: 'recent_list' },
      ];
  return {
    fields,
    primaryFieldId: valueField.id,
    target: params.targetValue ? { kind: 'total', value: params.targetValue, unit: params.unit } : undefined,
    views,
    entryNoun: 'entry',
  };
}

function moneyDefinition(params: CreateGoalParams): GoalDefinition {
  const currency = params.currency ?? '$';
  const amountField = field({ label: 'Amount', type: 'number', unit: currency });
  const fields = applyCustomization([amountField, field({ label: 'Note', type: 'text' })], params);
  return {
    fields,
    primaryFieldId: amountField.id,
    target: params.targetValue ? { kind: 'total', value: params.targetValue, unit: currency } : undefined,
    views: [{ kind: 'progress_total' }, { kind: 'recent_list' }],
    entryNoun: 'contribution',
  };
}

function journalDefinition(params: CreateGoalParams): GoalDefinition {
  const fields = applyCustomization(
    [
      field({ label: 'Entry', type: 'text', required: true }),
      field({ label: 'Rating', type: 'rating' }),
    ],
    params,
  );
  return { fields, views: [{ kind: 'recent_list' }], entryNoun: 'entry' };
}

/**
 * Assembles a full GoalDefinition from a template key + small, validated
 * params — the server owns the default field shapes; the model only ever
 * supplies bounded customization (unit/currency/target/extraFields/
 * omitFields), never a raw field array (phase-4-implementation-plan.md §1.2,
 * docs/ai-reliability-hardening.md lesson 2's "no storage shape" applied to
 * tool creation rather than task template/instance rows).
 */
export function buildTemplateDefinition(params: CreateGoalParams): GoalDefinition {
  switch (params.template) {
    case 'workout':
      return workoutDefinition(params);
    case 'habit':
      return habitDefinition(params);
    case 'numeric':
      return numericDefinition(params);
    case 'money':
      return moneyDefinition(params);
    case 'journal':
      return journalDefinition(params);
  }
}
