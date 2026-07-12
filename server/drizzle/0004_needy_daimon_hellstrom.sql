-- Goals redesign: rename tools/tool_entries -> goals/goal_entries end-to-end
-- (docs/goals-redesign-plan.md §2.1). Hand-written (not drizzle-kit generate
-- output) because drizzle-kit's rename-detection needs an interactive TTY
-- and this repo has no production users, so a clean rename is safe and
-- preferred over a destructive drop+create.

-- --- tools -> goals (table, index, FK) --------------------------------
ALTER TABLE "tools" RENAME TO "goals";--> statement-breakpoint
ALTER TABLE "goals" RENAME CONSTRAINT "tools_user_id_users_id_fk" TO "goals_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "tools_user_idx" RENAME TO "goals_user_idx";--> statement-breakpoint

-- --- tool_entries -> goal_entries (table, column, indexes, FKs) -------
ALTER TABLE "tool_entries" RENAME TO "goal_entries";--> statement-breakpoint
ALTER TABLE "goal_entries" RENAME COLUMN "tool_id" TO "goal_id";--> statement-breakpoint
ALTER TABLE "goal_entries" RENAME CONSTRAINT "tool_entries_tool_id_tools_id_fk" TO "goal_entries_goal_id_goals_id_fk";--> statement-breakpoint
ALTER TABLE "goal_entries" RENAME CONSTRAINT "tool_entries_record_id_records_id_fk" TO "goal_entries_record_id_records_id_fk";--> statement-breakpoint
ALTER INDEX "tool_entries_tool_idx" RENAME TO "goal_entries_goal_idx";--> statement-breakpoint

-- --- tasks.tool_id -> tasks.goal_id (column, FK) ----------------------
ALTER TABLE "tasks" RENAME COLUMN "tool_id" TO "goal_id";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "tasks_tool_id_tools_id_fk" TO "tasks_goal_id_goals_id_fk";--> statement-breakpoint

-- --- records.source check: drop first, the data UPDATE below needs to
-- write 'goal_ui' while the old check (which doesn't allow it yet) is gone,
-- then the new check is added once every row already satisfies it --------
ALTER TABLE "records" DROP CONSTRAINT "records_source_check";--> statement-breakpoint

-- --- data: record kinds tool_% -> goal_% (existing rows, never rewritten
-- as new rows — CLAUDE.md §2's "past records survive layout changes") ---
UPDATE "records" SET "kind" = 'goal_created' WHERE "kind" = 'tool_created';--> statement-breakpoint
UPDATE "records" SET "kind" = 'goal_edited' WHERE "kind" = 'tool_edited';--> statement-breakpoint
UPDATE "records" SET "kind" = 'goal_entry' WHERE "kind" = 'tool_entry';--> statement-breakpoint
UPDATE "records" SET "kind" = 'goal_archived' WHERE "kind" = 'tool_archived';--> statement-breakpoint
UPDATE "records" SET "kind" = 'goal_undo' WHERE "kind" = 'tool_undo';--> statement-breakpoint

-- --- data: records.source 'tool_ui' -> 'goal_ui' ----------------------
UPDATE "records" SET "source" = 'goal_ui' WHERE "source" = 'tool_ui';--> statement-breakpoint

ALTER TABLE "records" ADD CONSTRAINT "records_source_check" CHECK ("records"."source" in ('chat','tasks_ui','goal_ui','system'));--> statement-breakpoint

-- --- data: records.payload key toolId -> goalId (every tool_%/goal_%
-- record kind's payload used this key — see lib/tools/executor.ts and
-- lib/tasks/executor.ts's undoToolRecord) ------------------------------
UPDATE "records" SET "payload" = (payload - 'toolId') || jsonb_build_object('goalId', payload->'toolId') WHERE payload ? 'toolId';--> statement-breakpoint

-- --- data: messages.meta.kind tool_preview/tool_action -> goal_preview/
-- goal_action, and meta.toolId/createdToolId -> goalId/createdGoalId
-- (the chat preview card reads meta.createdToolId — routes/tools.ts) ---
UPDATE "messages" SET "meta" = jsonb_set(meta, '{kind}', '"goal_preview"') WHERE meta->>'kind' = 'tool_preview';--> statement-breakpoint
UPDATE "messages" SET "meta" = jsonb_set(meta, '{kind}', '"goal_action"') WHERE meta->>'kind' = 'tool_action';--> statement-breakpoint
UPDATE "messages" SET "meta" = (meta - 'toolId') || jsonb_build_object('goalId', meta->'toolId') WHERE meta ? 'toolId';--> statement-breakpoint
UPDATE "messages" SET "meta" = (meta - 'createdToolId') || jsonb_build_object('createdGoalId', meta->'createdToolId') WHERE meta ? 'createdToolId';
