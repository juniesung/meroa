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

export type TaskType = 'completion' | 'checklist' | 'counter' | 'duration' | 'numeric_meter' | 'recurring';
export type TaskStatus = 'open' | 'done' | 'archived';

export type ApiTask = {
  id: string;
  userId: string;
  type: TaskType;
  title: string;
  icon: string | null;
  config: Record<string, unknown>;
  recurrence: Record<string, unknown> | null;
  toolId: string | null;
  dueAt: string | null;
  status: TaskStatus;
  completedRecordId: string | null;
  createdFromMessageId: string | null;
  createdAt: string;
  deletedAt: string | null;
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
