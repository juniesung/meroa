import { relations } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// --- users -------------------------------------------------------------
// Phone number is the identity key: verifying the same number in the app
// resolves to the same user as any pre-install SMS-side identity (Phase 9).
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneE164: text('phone_e164').notNull().unique(),
  displayName: text('display_name'),
  timezone: text('timezone'),
  prefs: jsonb('prefs').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- otp_codes -----------------------------------------------------------
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phoneE164: text('phone_e164').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('otp_codes_phone_idx').on(t.phoneE164, t.createdAt)],
);

// --- sessions ------------------------------------------------------------
// Refresh tokens are hashed at rest and rotated on every use.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    deviceLabel: text('device_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// --- conversations ---------------------------------------------------------
// One logical relationship; channel is recorded per-conversation so an
// SMS-side thread and the in-app thread can merge into one continuity view.
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull().default('app'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userId),
    uniqueIndex('conversations_user_channel_unique').on(t.userId, t.channel),
    check('conversations_channel_check', sql`${t.channel} in ('app','sms')`),
  ],
);

// --- messages ------------------------------------------------------------
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    check('messages_role_check', sql`${t.role} in ('user','assistant','system')`),
  ],
);

// --- records ---------------------------------------------------------------
// The heart of "store once, render everywhere": every real-world action is
// one row here. Tasks and tool_entries reference a record; they never
// duplicate its data. Undo sets revertedAt — rows are never deleted.
export const records = pgTable(
  'records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    source: text('source').notNull(),
    sourceMessageId: uuid('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    // The Anthropic tool_use block's own id — one per individual tool call,
    // even when several calls share a sourceMessageId (a single chat turn
    // creating two tasks, or starting then stopping the same timer). Lets
    // idempotency key on "this exact tool call", not "this message + kind",
    // so distinct calls in one turn never collide with each other.
    toolCallId: text('tool_call_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
  },
  (t) => [
    index('records_user_idx').on(t.userId),
    check('records_source_check', sql`${t.source} in ('chat','tasks_ui','goal_ui','system')`),
  ],
);

// --- goals -----------------------------------------------------------------
// Layout edits bump `version`; historical entries are never rewritten.
export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    version: integer('version').notNull().default(1),
    definition: jsonb('definition').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('goals_user_idx').on(t.userId)],
);

// --- tasks -------------------------------------------------------------
// `type` covers all six Phase-3 task types up front so the column never
// needs to change shape later. `goalId` is the task<->goal link.
//
// A recurring task is a *template* row (`recurrence` non-null, `type` is
// still the per-instance base type — a daily counter is still a counter
// each day). Occurrences are separate dated *instance* rows: `templateId`
// points back at the template, `occurrenceDate` is that instance's calendar
// date, and `recurrence` is null on instances. The literal 'recurring'
// value in the type check below is unused (kept for column-shape history).
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('completion'),
    title: text('title').notNull(),
    icon: text('icon'),
    config: jsonb('config').notNull().default({}),
    recurrence: jsonb('recurrence'),
    goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: text('status').notNull().default('open'),
    completedRecordId: uuid('completed_record_id').references(() => records.id, {
      onDelete: 'set null',
    }),
    createdFromMessageId: uuid('created_from_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    templateId: uuid('template_id'),
    occurrenceDate: date('occurrence_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('tasks_user_idx').on(t.userId),
    check(
      'tasks_type_check',
      sql`${t.type} in ('completion','checklist','counter','duration','numeric_meter','recurring')`,
    ),
    check('tasks_status_check', sql`${t.status} in ('open','done','archived')`),
    // Partial unique index (not a FK — a template's instances reference it,
    // but nothing should ever cascade-delete a template out from under its
    // history) — makes lazy materialization idempotent under concurrent reads.
    uniqueIndex('tasks_template_occurrence_unique')
      .on(t.templateId, t.occurrenceDate)
      .where(sql`${t.templateId} is not null`),
  ],
);

// --- goal_entries ------------------------------------------------------
// An entry is a view of a record — never a second copy of the same action.
export const goalEntries = pgTable(
  'goal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull().default({}),
    entryAt: timestamp('entry_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goal_entries_goal_idx').on(t.goalId, t.entryAt)],
);

// --- memories ------------------------------------------------------------
// Sensitivity + suppression are enforced at the schema/query level from
// day one (CLAUDE.md §2: health/financial/emotional data is sensitive).
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    sensitive: boolean('sensitive').notNull().default(false),
    suppressed: boolean('suppressed').notNull().default(false),
    sourceMessageId: uuid('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('memories_user_idx').on(t.userId)],
);

// --- entitlements --------------------------------------------------------
// Server-side plan truth for Phase 7; never trust a client-asserted plan.
export const entitlements = pgTable(
  'entitlements',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('free'),
    source: text('source'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('entitlements_plan_check', sql`${t.plan} in ('free','plus')`)],
);

// --- relations ---------------------------------------------------------

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  conversations: many(conversations),
  records: many(records),
  tasks: many(tasks),
  goals: many(goals),
  memories: many(memories),
  entitlement: one(entitlements, {
    fields: [users.id],
    references: [entitlements.userId],
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const recordsRelations = relations(records, ({ one, many }) => ({
  user: one(users, { fields: [records.userId], references: [users.id] }),
  sourceMessage: one(messages, {
    fields: [records.sourceMessageId],
    references: [messages.id],
  }),
  goalEntries: many(goalEntries),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  user: one(users, { fields: [tasks.userId], references: [users.id] }),
  goal: one(goals, { fields: [tasks.goalId], references: [goals.id] }),
  completedRecord: one(records, {
    fields: [tasks.completedRecordId],
    references: [records.id],
  }),
}));

export const goalsRelations = relations(goals, ({ one, many }) => ({
  user: one(users, { fields: [goals.userId], references: [users.id] }),
  entries: many(goalEntries),
}));

export const goalEntriesRelations = relations(goalEntries, ({ one }) => ({
  goal: one(goals, { fields: [goalEntries.goalId], references: [goals.id] }),
  record: one(records, { fields: [goalEntries.recordId], references: [records.id] }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  user: one(users, { fields: [memories.userId], references: [users.id] }),
}));

export const entitlementsRelations = relations(entitlements, ({ one }) => ({
  user: one(users, { fields: [entitlements.userId], references: [users.id] }),
}));
