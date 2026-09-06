ALTER TABLE `people` ADD `about` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `experience` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `education` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `skills` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `keywords` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `people_search` USING fts5(`owner` UNINDEXED,`id` UNINDEXED,`name`,`headline`,`location`,`keywords`,tokenize='trigram');--> statement-breakpoint
INSERT INTO `people_search`(`owner`,`id`,`name`,`headline`,`location`,`keywords`)
SELECT `owner`,`id`,`name`,`headline`,`location`,lower(`name`||' '||`headline`||' '||`location`)
  ||CASE WHEN lower(`headline`||' '||`location`) LIKE '%san jose state university%' THEN ' sjsu san jose state' ELSE '' END
  ||CASE WHEN lower(`headline`||' '||`location`) LIKE '%california polytechnic state university%' THEN ' cal poly calpoly cpslo' ELSE '' END
  ||CASE WHEN lower(`headline`||' '||`location`) LIKE '%university of california, berkeley%' OR lower(`headline`||' '||`location`) LIKE '%uc berkeley%' THEN ' ucb uc berkeley cal berkeley' ELSE '' END
  ||CASE WHEN lower(`headline`||' '||`location`) LIKE '%university of california, los angeles%' OR lower(`headline`||' '||`location`) LIKE '%ucla%' THEN ' ucla' ELSE '' END
FROM `people`;
