CREATE TABLE `evidence_contributors` (
	`owner` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`source` text NOT NULL,
	`contributor_id` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `a`, `b`, `source`, `contributor_id`)
);
--> statement-breakpoint
CREATE INDEX `evidence_contributors_account` ON `evidence_contributors` (`contributor_id`,`a`,`b`);