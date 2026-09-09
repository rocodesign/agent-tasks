CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_email` text NOT NULL,
	`project` text NOT NULL,
	`type` text NOT NULL,
	`producer` text NOT NULL,
	`event_key` text NOT NULL,
	`session_id` text,
	`delegation` text,
	`machine_id` text,
	`recipient` text,
	`reply_to` integer,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `events_key_idx` ON `events` (`account_email`,`producer`,`event_key`);--> statement-breakpoint
CREATE INDEX `events_stream_idx` ON `events` (`account_email`,`project`,`id`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);
