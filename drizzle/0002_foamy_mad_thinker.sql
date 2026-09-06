CREATE TABLE `import_records` (
	`owner` text NOT NULL,
	`import_id` text NOT NULL,
	`section` text NOT NULL,
	`record_index` integer NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`owner`, `import_id`, `section`, `record_index`)
);
--> statement-breakpoint
CREATE INDEX `import_records_section` ON `import_records` (`owner`,`section`);--> statement-breakpoint
CREATE TABLE `imports` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`file_name` text NOT NULL,
	`format` text NOT NULL,
	`schema_version` text NOT NULL,
	`exported_at` text NOT NULL,
	`metadata_json` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
