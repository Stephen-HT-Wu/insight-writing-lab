CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`brief` text NOT NULL,
	`status` text NOT NULL,
	`revision_count` integer DEFAULT 0 NOT NULL,
	`title` text,
	`thesis` text,
	`markdown` text,
	`sources_json` text DEFAULT '[]' NOT NULL,
	`reviews_json` text DEFAULT '[]' NOT NULL,
	`unresolved_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
