import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  brief: text("brief").notNull(),
  status: text("status").notNull(),
  revisionCount: integer("revision_count").notNull().default(0),
  title: text("title"),
  thesis: text("thesis"),
  markdown: text("markdown"),
  sourcesJson: text("sources_json").notNull().default("[]"),
  reviewsJson: text("reviews_json").notNull().default("[]"),
  unresolvedJson: text("unresolved_json").notNull().default("[]"),
  researchGapsJson: text("research_gaps_json").notNull().default("[]"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowEvents = sqliteTable("workflow_events", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  phase: text("phase").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("workflow_events_sequence_idx").on(table.workflowId, table.sequence)]);
