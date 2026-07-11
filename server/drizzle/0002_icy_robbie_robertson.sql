ALTER TABLE "tasks" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_template_occurrence_unique" ON "tasks" USING btree ("template_id","occurrence_date") WHERE "tasks"."template_id" is not null;