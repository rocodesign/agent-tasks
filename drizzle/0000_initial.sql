CREATE TABLE `accounts` (
	`email` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_email_idx` ON `api_keys` (`email`);--> statement-breakpoint
CREATE TABLE `dismissals` (
	`session_id` text NOT NULL,
	`task_name` text NOT NULL,
	`account_email` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	PRIMARY KEY(`session_id`, `task_name`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`account_email` text NOT NULL,
	`hostname` text NOT NULL,
	`os` text,
	`label` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machines_account_idx` ON `machines` (`account_email`);--> statement-breakpoint
CREATE INDEX `machines_updated_idx` ON `machines` (`updated_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_email` text NOT NULL,
	`machine_id` text NOT NULL,
	`project` text,
	`title` text,
	`provider` text,
	`summary` text,
	`summarized_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`ended_reason` text,
	`started_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_account_idx` ON `sessions` (`account_email`);--> statement-breakpoint
CREATE INDEX `sessions_machine_idx` ON `sessions` (`machine_id`);--> statement-breakpoint
CREATE INDEX `sessions_updated_idx` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_email` text NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'live' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_account_idx` ON `tasks` (`account_email`);--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_updated_idx` ON `tasks` (`updated_at`);--> statement-breakpoint
CREATE TABLE `verification` (
	`identifier` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
