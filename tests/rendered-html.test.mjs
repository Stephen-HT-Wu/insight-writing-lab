import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Insight Writing Lab product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Insight Writing Lab/);
  assert.match(html, /開始研究與寫作/);
  assert.match(html, /文章與審稿紀錄/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("includes durable, resumable workflow steps and live streaming UI", async () => {
  const [worker, page, eventMigration, leaseMigration, draftMigration] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_nifty_azazel.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_low_tinkerer.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_bizarre_serpent_society.sql", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /stream:\s*true/);
  assert.match(worker, /response\.output_text\.delta/);
  assert.match(worker, /text\/event-stream/);
  assert.match(worker, /workflow_events/);
  assert.match(worker, /advanceWorkflow/);
  assert.match(worker, /lease_expires_at/);
  assert.doesNotMatch(worker, /waitUntil\(runWorkflow/);
  assert.match(page, /new EventSource/);
  assert.match(page, /draft_delta/);
  assert.match(page, /\/advance/);
  assert.match(page, /ReactMarkdown/);
  assert.match(page, /草稿版本與總編意見/);
  assert.match(eventMigration, /CREATE TABLE `workflow_events`/);
  assert.match(eventMigration, /CREATE UNIQUE INDEX `workflow_events_sequence_idx`/);
  assert.match(leaseMigration, /research_gaps_json/);
  assert.match(leaseMigration, /lease_expires_at/);
  assert.match(draftMigration, /drafts_json/);
});
