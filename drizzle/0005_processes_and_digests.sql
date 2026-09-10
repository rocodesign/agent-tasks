CREATE TABLE `machine_processes` (
	`account_email` text NOT NULL,
	`machine` text NOT NULL,
	`process` text NOT NULL,
	`last_seen` integer NOT NULL,
	`interval_ms` integer NOT NULL,
	`version` text,
	PRIMARY KEY(`account_email`, `machine`, `process`),
	FOREIGN KEY (`account_email`) REFERENCES `accounts`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machine_processes_account_idx` ON `machine_processes` (`account_email`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `proposed_tags` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `digest_failed_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `digest_failed_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `digest_failed_attempts` integer;
