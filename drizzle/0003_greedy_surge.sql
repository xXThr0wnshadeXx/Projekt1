CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`display_name` text,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`provider`, `subject`)
);
--> statement-breakpoint
CREATE INDEX `identities_user` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`display_name` text,
	`linkedin_profile_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
