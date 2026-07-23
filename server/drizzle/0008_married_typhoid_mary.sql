CREATE TABLE "achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"tier" integer NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone,
	CONSTRAINT "achievements_key_check" CHECK ("achievements"."key" in ('tasks_completed','streak','goals_started','goals_finished'))
);
--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievements_user_idx" ON "achievements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "achievements_user_key_tier_unique" ON "achievements" USING btree ("user_id","key","tier");