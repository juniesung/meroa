CREATE TABLE "memory_extraction_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_message_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_state" ADD CONSTRAINT "memory_extraction_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_state" ADD CONSTRAINT "memory_extraction_state_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "memories" SET "kind" = 'situation' WHERE "kind" = 'goal';--> statement-breakpoint
UPDATE "memories" SET "kind" = 'trait' WHERE "kind" = 'pattern';--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_kind_check" CHECK ("memories"."kind" in ('preference','trait','relationship','situation'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_check" CHECK ("memories"."source" in ('chat_explicit','extracted','manual'));