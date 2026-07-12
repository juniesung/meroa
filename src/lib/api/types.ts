export type ApiUser = {
  id: string;
  phoneE164: string;
  displayName: string | null;
  timezone: string | null;
  prefs: Record<string, unknown>;
};

export type ApiEntitlement = {
  plan: 'free' | 'plus';
  expiresAt: string | null;
};

export type ApiMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

export type ApiMemory = {
  id: string;
  userId: string;
  kind: string;
  content: string;
  sensitive: boolean;
  suppressed: boolean;
  sourceMessageId: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export type TaskType = 'completion' | 'checklist' | 'counter' | 'duration';
export type TaskStatus = 'open' | 'done' | 'archived';
export type Weekday = 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su';

export type Recurrence =
  | { freq: 'daily'; time?: string }
  | { freq: 'weekly'; byWeekday: Weekday[]; time?: string }
  | { freq: 'every_n_days'; n: number; time?: string };

export type ChecklistItem = { id: string; text: string; done: boolean };

export type CompletionConfig = { note?: string; reminder?: boolean; dueTimeExplicit?: boolean };
export type ChecklistConfig = { items: ChecklistItem[]; reminder?: boolean; dueTimeExplicit?: boolean };
export type CounterConfig = {
  count: number;
  target: number;
  unit?: string;
  reminder?: boolean;
  dueTimeExplicit?: boolean;
};
export type DurationConfig = {
  loggedMinutes: number;
  targetMinutes: number;
  runningSince?: string | null;
  reminder?: boolean;
  dueTimeExplicit?: boolean;
};
export type TaskConfigFor<T extends TaskType> = T extends 'completion'
  ? CompletionConfig
  : T extends 'checklist'
    ? ChecklistConfig
    : T extends 'counter'
      ? CounterConfig
      : DurationConfig;

export type ApiTask = {
  id: string;
  userId: string;
  type: TaskType;
  title: string;
  icon: string | null;
  config: CompletionConfig | ChecklistConfig | CounterConfig | DurationConfig;
  recurrence: Recurrence | null;
  goalId: string | null;
  dueAt: string | null;
  status: TaskStatus;
  completedRecordId: string | null;
  createdFromMessageId: string | null;
  templateId: string | null;
  occurrenceDate: string | null;
  createdAt: string;
  deletedAt: string | null;
};

// --- create/edit/progress inputs (mirror server/src/lib/tasks/schema.ts) ---

type SharedCreateFields = {
  title: string;
  icon?: string;
  dueAt?: string;
  note?: string;
  recurrence?: Recurrence;
  reminder?: boolean;
};

export type CreateTaskInput =
  | ({ type: 'completion' } & SharedCreateFields)
  | ({ type: 'checklist'; items: string[] } & SharedCreateFields)
  | ({ type: 'counter'; target: number; unit?: string } & SharedCreateFields)
  | ({ type: 'duration'; targetMinutes: number } & SharedCreateFields);

export type EditTaskPatch = {
  title?: string;
  icon?: string | null;
  dueAt?: string | null;
  note?: string;
  recurrence?: Recurrence | null;
  items?: string[];
  target?: number;
  unit?: string;
  targetMinutes?: number;
  reminder?: boolean;
};

export type ProgressInput =
  | { kind: 'mark_done' }
  | { kind: 'mark_open' }
  | { kind: 'checklist_toggle'; itemId: string }
  | { kind: 'checklist_complete'; itemIds?: string[] }
  | { kind: 'counter_increment'; amount?: number }
  | { kind: 'counter_set'; count: number }
  | { kind: 'duration_start' }
  | { kind: 'duration_stop' }
  | { kind: 'duration_add_minutes'; minutes: number }
  | { kind: 'duration_set_minutes'; minutes: number }
  | { kind: 'reopen' };

export type CompleteTaskInput = { value?: number; itemIds?: string[] };

export type PostponeTaskInput = {
  newDueAt: string | null;
  reason?: 'bad_timing' | 'low_energy' | 'avoided' | null;
};

// --- goals (mirrors server/src/lib/goals/schema.ts) ------------------------
// Two goal types: savings (a fixed { currency, targetValue, deadline? }
// shape) and habit (no numbers — a linked daily task + streak is the whole
// mechanic). No field builder.

export type GoalTemplateKey = 'savings' | 'habit';

export type GoalDefinition =
  | {
      type: 'savings';
      currency: string;
      targetValue: number;
      deadline?: string;
      checkInCadence?: 'weekly' | 'off';
    }
  | {
      type: 'habit';
      checkInCadence?: 'weekly' | 'off';
    };

export type StarterTask = {
  title: string;
  recurrence?: Recurrence;
  // Savings only — the amount completing the task auto-logs. Habit
  // check-in tasks carry no amount.
  contribution?: number;
};

export type GoalStreak = { current: number; longest: number; doneCount: number };

// What create_goal returns for display before anything is saved — stored on
// a goal_preview message's meta.preview, and what POST /goals sends back.
export type GoalPreview = {
  template: GoalTemplateKey;
  name: string;
  icon: string | null;
  definition: GoalDefinition;
  starterTasks?: StarterTask[];
};

export type ApiGoal = {
  id: string;
  userId: string;
  template: string;
  name: string;
  icon: string | null;
  version: number;
  definition: GoalDefinition;
  createdAt: string;
  archivedAt: string | null;
  // Card summary fields, precomputed server-side (lib/goals/summary.ts) —
  // present on the GET /goals list response.
  entryCount: number;
  headline?: string;
  sub?: string;
  progress?: number | null;
  paceLine?: string | null;
  // Habit goals only — null/absent for savings.
  streak?: GoalStreak | null;
  lastEntryAt?: string | null;
};

export type GoalEntryData = { amount: number; note?: string };

export type ApiGoalEntry = {
  id: string;
  goalId: string;
  recordId: string;
  data: GoalEntryData;
  entryAt: string;
  createdAt: string;
};

export type ApiGoalDetail = {
  type: 'savings' | 'habit';
  card: { headline: string; sub: string; progress: number | null; paceLine: string | null };
  // Savings fields — null on a habit detail.
  total: number | null;
  targetValue: number | null;
  currency: string | null;
  deadline: string | null;
  // Habit field — null on a savings detail.
  streak: GoalStreak | null;
  entryCount: number;
  lastEntryAt: string | null;
};

// Mirrors server/src/lib/goals/consistency.ts — client renders, never
// re-buckets (docs/goals-redesign-plan.md §2.4, lesson 12).
export type DayVerdict = 'perfect' | 'missed' | 'neutral';

export type DayBucket = {
  ymd: string;
  dueCount: number;
  doneCount: number;
  verdict: DayVerdict;
  level: 0 | 1 | 2 | 3;
};

export type ApiGoalConsistency = {
  current: number;
  longest: number;
  calendar: DayBucket[];
};

export type CreateGoalParams = {
  type?: 'savings' | 'habit';
  name: string;
  icon?: string;
  currency?: string;
  targetValue?: number;
  deadline?: string;
};

export type EditGoalPatch = {
  name?: string;
  icon?: string;
  targetValue?: number;
  deadline?: string;
};

export type LogGoalEntryPatch = {
  amount: number;
  note?: string;
  entryAt?: string;
};

export type BootstrapResponse = {
  user: ApiUser;
  entitlement: ApiEntitlement;
  conversationId: string;
  messages: ApiMessage[];
  memories: ApiMemory[];
  tasks: ApiTask[];
  goals: ApiGoal[];
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type VerifyOtpResponse = AuthTokens & {
  isNewUser: boolean;
  user: ApiUser;
};
