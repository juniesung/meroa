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
  toolId: string | null;
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

export type ApiTool = {
  id: string;
  userId: string;
  template: string;
  name: string;
  icon: string | null;
  version: number;
  definition: Record<string, unknown>;
  createdAt: string;
  archivedAt: string | null;
  entryCount: number;
};

export type BootstrapResponse = {
  user: ApiUser;
  entitlement: ApiEntitlement;
  conversationId: string;
  messages: ApiMessage[];
  memories: ApiMemory[];
  tasks: ApiTask[];
  tools: ApiTool[];
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type VerifyOtpResponse = AuthTokens & {
  isNewUser: boolean;
  user: ApiUser;
};
