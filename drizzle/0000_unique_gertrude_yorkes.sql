CREATE TABLE `connections` (
	`owner` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `a`, `b`)
);
--> statement-breakpoint
CREATE INDEX `connections_reverse` ON `connections` (`owner`,`b`,`a`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`owner` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`source` text NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`owner`, `a`, `b`, `source`)
);
--> statement-breakpoint
CREATE TABLE `people` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`search_name` text NOT NULL,
	`headline` text NOT NULL,
	`location` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `people_name` ON `people` (`owner`,`search_name`,`id`);