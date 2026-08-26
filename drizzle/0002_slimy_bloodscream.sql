ALTER TABLE "sessions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "summarized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source" text DEFAULT 'live' NOT NULL;