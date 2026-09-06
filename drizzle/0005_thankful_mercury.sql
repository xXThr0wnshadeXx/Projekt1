CREATE TABLE `connection_contributors` (
	`owner` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`contributor_id` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `a`, `b`, `contributor_id`)
);
--> statement-breakpoint
CREATE INDEX `connection_contributors_account` ON `connection_contributors` (`contributor_id`,`a`,`b`);--> statement-breakpoint
CREATE TABLE `people_contributors` (
	`owner` text NOT NULL,
	`person_id` text NOT NULL,
	`contributor_id` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `person_id`, `contributor_id`)
);
--> statement-breakpoint
CREATE INDEX `people_contributors_account` ON `people_contributors` (`contributor_id`,`person_id`);