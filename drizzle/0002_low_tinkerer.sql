ALTER TABLE `workflows` ADD `research_gaps_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `lease_expires_at` text;