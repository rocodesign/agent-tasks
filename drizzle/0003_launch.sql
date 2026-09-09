ALTER TABLE `events` ADD `launch` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `role` text;--> statement-breakpoint
CREATE INDEX `events_recipient_idx` ON `events` (`account_email`,`recipient`,`id`);
