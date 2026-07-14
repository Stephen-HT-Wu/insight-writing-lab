CREATE TABLE `workflow_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`phase` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_events_sequence_idx` ON `workflow_events` (`workflow_id`,`sequence`);