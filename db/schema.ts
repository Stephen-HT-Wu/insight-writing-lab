import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
