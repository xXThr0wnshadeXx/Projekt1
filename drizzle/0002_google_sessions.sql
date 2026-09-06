CREATE TABLE `google_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`email` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `google_sessions_expiry` ON `google_sessions` (`expires_at`);
