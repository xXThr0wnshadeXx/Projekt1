CREATE TABLE `collection_coverage` (
	`owner` text NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`contributor_id` text NOT NULL,
	`status` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`checked_at` text NOT NULL,
	`reusable` integer DEFAULT 0 NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`owner`, `person_id`, `kind`, `contributor_id`)
);
--> statement-breakpoint
CREATE INDEX `collection_coverage_lookup` ON `collection_coverage` (`owner`,`person_id`,`kind`,`reusable`,`checked_at`);--> statement-breakpoint
CREATE INDEX `collection_coverage_contributor` ON `collection_coverage` (`contributor_id`,`person_id`,`kind`);