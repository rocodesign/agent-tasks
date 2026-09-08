ALTER TABLE `sessions` ADD `project_key` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ticket_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `delegation` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `category` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `decisions` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `summary_version` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `summarized_through` text;--> statement-breakpoint
CREATE INDEX `sessions_project_key_idx` ON `sessions` (`project_key`);--> statement-breakpoint
CREATE INDEX `sessions_kind_idx` ON `sessions` (`kind`);