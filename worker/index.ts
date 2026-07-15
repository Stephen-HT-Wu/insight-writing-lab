/** Cloudflare Worker entry point for the editorial agent workspace. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import writerSkill from "../skills/rigorous-writer/SKILL.md?raw";
import sourcePolicy from "../skills/rigorous-writer/references/source-policy.md?raw";
import argumentation from "../skills/rigorous-writer/references/argumentation.md?raw";
import editorSkill from "../skills/independent-editor/SKILL.md?raw";
import reviewRubric from "../skills/independent-editor/references/review-rubric.md?raw";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  TAVILY_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Source = { title: string; url: string; content: string; score: number; authority: string };
type WriterResult = { title: string; thesis: string; markdown: string; research_gaps: string[]; unresolved: string[] };
type ReviewIssue = { severity: string; category: string; problem: string; required_change: string };
type Review = { decision: "pass" | "minor_revision" | "major_revision"; summary: string; strengths: string[]; issues: ReviewIssue[]; research_queries: string[]; draft_phase?: string };
type DraftSnapshot = { phase: string; label: string; title: string; thesis: string; markdown: string; created_at: string };
type WorkflowEventType = "status" | "research" | "draft_reset" | "draft_delta" | "review" | "completed" | "error";
type WorkflowRow = {
  id: string; topic: string; brief: string; status: string; revision_count: number;
  title: string | null; thesis: string | null; markdown: string | null;
  sources_json: string; reviews_json: string; unresolved_json: string; research_gaps_json: string; drafts_json: string;
  lease_token: string | null; lease_expires_at: string | null; error: string | null;
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

async function ensureDb(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL,
      revision_count INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      thesis TEXT,
      markdown TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]',
      reviews_json TEXT NOT NULL DEFAULT '[]',
      unresolved_json TEXT NOT NULL DEFAULT '[]',
      research_gaps_json TEXT NOT NULL DEFAULT '[]',
      drafts_json TEXT NOT NULL DEFAULT '[]',
      lease_token TEXT,
      lease_expires_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS workflows_updated_idx ON workflows(updated_at DESC)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      phase TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_sequence_idx ON workflow_events(workflow_id, sequence)"),
  ]);
}

async function emitEvent(db: D1Database, workflowId: string, type: WorkflowEventType, phase: string, content: unknown) {
  const latest = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_events WHERE workflow_id = ?")
    .bind(workflowId).first<{ sequence: number }>();
  const sequence = Number(latest?.sequence || 0) + 1;
  await db.prepare("INSERT INTO workflow_events (id, workflow_id, sequence, type, phase, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), workflowId, sequence, type, phase, typeof content === "string" ? content : JSON.stringify(content), new Date().toISOString()).run();
}

function rowToWorkflow(row: Record<string, unknown>) {
  return {
    ...row,
    sources: JSON.parse(String(row.sources_json || "[]")),
    reviews: JSON.parse(String(row.reviews_json || "[]")),
    unresolved: JSON.parse(String(row.unresolved_json || "[]")),
    research_gaps: JSON.parse(String(row.research_gaps_json || "[]")),
    drafts: JSON.parse(String(row.drafts_json || "[]")),
    sources_json: undefined,
    reviews_json: undefined,
    unresolved_json: undefined,
    research_gaps_json: undefined,
    drafts_json: undefined,
    lease_token: undefined,
  };
}

function authorityFor(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/\.gov\b|\.gov\.|\.int$/.test(host)) return "primary-official";
  if (/\.edu\b|\.ac\.|doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com/.test(host)) return "academic";
  if (/who\.int|oecd\.org|worldbank\.org|un\.org|europa\.eu/.test(host)) return "institutional";
  return "editorially-accountable-or-secondary";
}

async function tavilySearch(env: Env, queries: string[]): Promise<Source[]> {
  if (!env.TAVILY_API_KEY) throw new Error("尚未設定 TAVILY_API_KEY");
  const limited = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 6);
  const batches = await Promise.all(limited.map(async (query) => {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, search_depth: "advanced", max_results: 5, include_raw_content: "markdown", chunks_per_source: 3 }),
    });
    if (!response.ok) throw new Error(`Tavily 搜尋失敗（${response.status}）`);
    const payload = await response.json() as { results?: Array<{ title: string; url: string; content?: string; raw_content?: string; score?: number }> };
    return (payload.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      content: (item.raw_content || item.content || "").slice(0, 8000),
      score: item.score || 0,
      authority: authorityFor(item.url),
    }));
  }));
  const byUrl = new Map<string, Source>();
  for (const source of batches.flat()) {
    const previous = byUrl.get(source.url);
    if (!previous || source.score > previous.score) byUrl.set(source.url, source);
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, 18);
}

function parseModelJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned) as T; } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("模型未回傳有效 JSON");
  }
}

async function modelJson<T>(env: Env, instructions: string, input: string): Promise<T> {
  if (!env.OPENAI_API_KEY) throw new Error("尚未設定 OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      instructions,
      input,
    }),
  });
  const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI 呼叫失敗（${response.status}）`);
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("") || "";
  return parseModelJson<T>(text);
}

function partialJsonString(source: string, key: string) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(source);
  if (!match) return "";
  let result = "";
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') break;
    if (char !== "\\") { result += char; continue; }
    const escaped = source[++index];
    if (escaped === undefined) break;
    if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "t") result += "\t";
    else if (escaped === "b") result += "\b";
    else if (escaped === "f") result += "\f";
    else if (escaped === "u") {
      const hex = source.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      result += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else result += escaped;
  }
  return result;
}

async function modelJsonStream<T>(env: Env, instructions: string, input: string, onMarkdownDelta: (delta: string) => Promise<void>): Promise<T> {
  if (!env.OPENAI_API_KEY) throw new Error("尚未設定 OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      instructions,
      input,
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(payload.error?.message || `OpenAI 呼叫失敗（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let visibleMarkdown = "";
  let pendingDelta = "";
  const flush = async () => {
    if (!pendingDelta) return;
    const delta = pendingDelta;
    pendingDelta = "";
    await onMarkdownDelta(delta);
  };

  const consume = async (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as { type?: string; delta?: string; error?: { message?: string } };
    if (event.type === "error") throw new Error(event.error?.message || "OpenAI 串流失敗");
    if (event.type !== "response.output_text.delta" || !event.delta) return;
    output += event.delta;
    const nextVisible = partialJsonString(output, "markdown");
    if (nextVisible.length > visibleMarkdown.length) {
      pendingDelta += nextVisible.slice(visibleMarkdown.length);
      visibleMarkdown = nextVisible;
      if (pendingDelta.length >= 180 || pendingDelta.includes("\n\n")) await flush();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) await consume(block);
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  await flush();
  return parseModelJson<T>(output);
}

function evidencePacket(sources: Source[]) {
  return sources.map((source, index) => `SOURCE ${index + 1}\nTitle: ${source.title}\nURL: ${source.url}\nAuthority: ${source.authority}\nContent:\n${source.content}`).join("\n\n---\n\n");
}

const writerInstructions = `${writerSkill}\n\n${sourcePolicy}\n\n${argumentation}\n\nReturn JSON only. Write in Traditional Chinese unless the brief explicitly requests another language.`;
const editorInstructions = `${editorSkill}\n\n${reviewRubric}\n\nReturn JSON only. Review in Traditional Chinese.`;

const parseArray = <T,>(value: string | null | undefined): T[] => JSON.parse(value || "[]") as T[];
const mergeSources = (current: Source[], extra: Source[], limit: number) =>
  [...new Map([...current, ...extra].map((source) => [source.url, source])).values()].slice(0, limit);

async function setStatus(env: Env, id: string, status: string, message: string) {
  await env.DB.prepare("UPDATE workflows SET status = ?, error = NULL, updated_at = ? WHERE id = ?")
    .bind(status, new Date().toISOString(), id).run();
  await emitEvent(env.DB, id, "status", status, message);
}

async function streamArticle(env: Env, id: string, phase: string, prompt: string) {
  await emitEvent(env.DB, id, "draft_reset", phase, "");
  return modelJsonStream<WriterResult>(env, writerInstructions, prompt, (delta) => emitEvent(env.DB, id, "draft_delta", phase, delta));
}

async function saveArticle(env: Env, id: string, phase: string, label: string, article: WriterResult) {
  const current = await env.DB.prepare("SELECT drafts_json FROM workflows WHERE id = ?").bind(id).first<{ drafts_json: string }>();
  const snapshot: DraftSnapshot = { phase, label, title: article.title, thesis: article.thesis, markdown: article.markdown, created_at: new Date().toISOString() };
  const drafts = [...parseArray<DraftSnapshot>(current?.drafts_json).filter((draft) => draft.phase !== phase), snapshot];
  await env.DB.prepare("UPDATE workflows SET title = ?, thesis = ?, markdown = ?, unresolved_json = ?, research_gaps_json = ?, drafts_json = ?, updated_at = ? WHERE id = ?")
    .bind(article.title, article.thesis, article.markdown, JSON.stringify(article.unresolved || []), JSON.stringify(article.research_gaps || []), JSON.stringify(drafts), new Date().toISOString(), id).run();
}

async function finalizeWorkflow(env: Env, row: WorkflowRow) {
  const reviews = parseArray<Review>(row.reviews_json);
  const unresolved = [...new Set([
    ...parseArray<string>(row.unresolved_json),
    ...(reviews.at(-1)?.decision === "pass" ? [] : reviews.at(-1)?.issues.map((issue) => issue.problem) || []),
  ])];
  await env.DB.prepare("UPDATE workflows SET status = 'finalized', unresolved_json = ?, lease_token = NULL, lease_expires_at = NULL, error = NULL, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(unresolved), new Date().toISOString(), row.id).run();
  await emitEvent(env.DB, row.id, "completed", "finalized", { title: row.title, revision_count: row.revision_count });
}

async function claimWorkflow(env: Env, row: WorkflowRow) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
  await env.DB.prepare("UPDATE workflows SET lease_token = ?, lease_expires_at = ? WHERE id = ? AND status = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)")
    .bind(token, expires, row.id, row.status, now.toISOString()).run();
  const claimed = await env.DB.prepare("SELECT lease_token FROM workflows WHERE id = ?").bind(row.id).first<{ lease_token: string | null }>();
  return claimed?.lease_token === token ? token : null;
}

async function advanceWorkflow(env: Env, id: string) {
  let row = await env.DB.prepare("SELECT * FROM workflows WHERE id = ?").bind(id).first<WorkflowRow>();
  if (!row) return { status: 404, body: { error: "找不到任務" } };
  if (["finalized", "failed"].includes(row.status)) return { status: 200, body: { id, status: row.status } };
  const leaseToken = await claimWorkflow(env, row);
  if (!leaseToken) return { status: 202, body: { id, status: row.status, busy: true } };

  try {
    let sources = parseArray<Source>(row.sources_json);
    let reviews = parseArray<Review>(row.reviews_json);

    if (row.status === "queued" || row.status === "researching") {
      await setStatus(env, id, "researching", "正在從權威研究、官方統計與反方觀點建立證據基礎");
      sources = await tavilySearch(env, [
        `${row.topic} authoritative research evidence`,
        `${row.topic} official statistics primary sources`,
        `${row.topic} strongest criticism counterargument`,
        `${row.topic} recent systematic review expert analysis`,
      ]);
      await env.DB.prepare("UPDATE workflows SET sources_json = ? WHERE id = ?").bind(JSON.stringify(sources), id).run();
      await emitEvent(env.DB, id, "research", "researching", { message: `已整理 ${sources.length} 個研究來源`, sources: sources.slice(0, 8).map(({ title, url, authority }) => ({ title, url, authority })) });
      await setStatus(env, id, "drafting", "研究已保存；下一步將撰寫初稿");
    } else if (row.status === "drafting") {
      if (!sources.length) {
        await setStatus(env, id, "researching", "找不到已保存的研究資料，將重新研究");
      } else {
        const article = await streamArticle(env, id, "drafting", `TOPIC:\n${row.topic}\n\nBRIEF:\n${row.brief}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);
        await saveArticle(env, id, "drafting", "初稿", article);
        await setStatus(env, id, article.research_gaps?.length ? "researching_gaps" : "editing_1", article.research_gaps?.length ? `初稿已保存；下一步補查 ${article.research_gaps.length} 個證據缺口` : "初稿已保存；下一步交由獨立總編審稿");
      }
    } else if (row.status === "researching_gaps") {
      const gaps = parseArray<string>(row.research_gaps_json);
      const extra = gaps.length ? await tavilySearch(env, gaps) : [];
      sources = mergeSources(sources, extra, 24);
      await env.DB.prepare("UPDATE workflows SET sources_json = ? WHERE id = ?").bind(JSON.stringify(sources), id).run();
      await emitEvent(env.DB, id, "research", "researching_gaps", { message: `補查已保存，目前共有 ${sources.length} 個來源` });
      await setStatus(env, id, "redrafting_with_evidence", "下一步將補充證據整合進文章");
    } else if (row.status === "redrafting_with_evidence") {
      const article = await streamArticle(env, id, row.status, `Rewrite the draft after resolving its research gaps.\n\nTOPIC:\n${row.topic}\n\nBRIEF:\n${row.brief}\n\nPRIOR DRAFT:\n${row.markdown || ""}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);
      await saveArticle(env, id, "redrafting_with_evidence", "補證改寫", article);
      await setStatus(env, id, "editing_1", "證據版草稿已保存；下一步交由獨立總編審稿");
    } else if (/^editing_\d+$/.test(row.status)) {
      const round = Number(row.status.split("_")[1]);
      const review = await modelJson<Review>(env, editorInstructions, `TOPIC:\n${row.topic}\n\nARTICLE:\n${row.markdown || ""}\n\nAVAILABLE SOURCES:\n${evidencePacket(sources)}`);
      const latestDraft = parseArray<DraftSnapshot>(row.drafts_json).at(-1);
      review.draft_phase = latestDraft?.phase;
      reviews = [...reviews, review];
      await env.DB.prepare("UPDATE workflows SET reviews_json = ? WHERE id = ?").bind(JSON.stringify(reviews), id).run();
      await emitEvent(env.DB, id, "review", row.status, { decision: review.decision, summary: review.summary, issue_count: review.issues?.length || 0 });
      if (review.decision === "pass") {
        row = { ...row, reviews_json: JSON.stringify(reviews) };
        await finalizeWorkflow(env, row);
      } else {
        await env.DB.prepare("UPDATE workflows SET revision_count = ? WHERE id = ?").bind(round, id).run();
        await setStatus(env, id, review.research_queries?.length ? `researching_revision_${round}` : `revising_${round}`, review.research_queries?.length ? `總編第 ${round} 輪意見已保存；下一步補查 ${review.research_queries.length} 個問題` : `總編第 ${round} 輪意見已保存；下一步進行修訂`);
      }
    } else if (/^researching_revision_\d+$/.test(row.status)) {
      const round = Number(row.status.split("_")[2]);
      const queries = reviews.at(-1)?.research_queries || [];
      const extra = queries.length ? await tavilySearch(env, queries) : [];
      sources = mergeSources(sources, extra, 28);
      await env.DB.prepare("UPDATE workflows SET sources_json = ? WHERE id = ?").bind(JSON.stringify(sources), id).run();
      await emitEvent(env.DB, id, "research", row.status, { message: `第 ${round} 輪補查已保存，目前共有 ${sources.length} 個來源` });
      await setStatus(env, id, `revising_${round}`, `下一步依第 ${round} 輪總編意見修訂文章`);
    } else if (/^revising_\d+$/.test(row.status)) {
      const round = Number(row.status.split("_")[1]);
      const review = reviews.at(-1);
      const article = await streamArticle(env, id, row.status, `Revise the article in response to the independent editor. Preserve sound reasoning; address substantive issues. This is revision ${round} of at most 3.\n\nTOPIC:\n${row.topic}\n\nBRIEF:\n${row.brief}\n\nCURRENT ARTICLE:\n${row.markdown || ""}\n\nEDITOR REVIEW:\n${JSON.stringify(review)}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);
      await saveArticle(env, id, row.status, `第 ${round} 次修訂`, article);
      if (round >= 3) {
        row = { ...row, title: article.title, thesis: article.thesis, markdown: article.markdown, unresolved_json: JSON.stringify(article.unresolved || []), reviews_json: JSON.stringify(reviews), revision_count: round };
        await finalizeWorkflow(env, row);
      } else {
        await setStatus(env, id, `editing_${round + 1}`, `第 ${round} 次修訂已保存；下一步進行第 ${round + 1} 輪審稿`);
      }
    } else {
      throw new Error(`未知的工作階段：${row.status}`);
    }

    await env.DB.prepare("UPDATE workflows SET lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?")
      .bind(id, leaseToken).run();
    const latest = await env.DB.prepare("SELECT status FROM workflows WHERE id = ?").bind(id).first<{ status: string }>();
    return { status: 200, body: { id, status: latest?.status || row.status } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare("UPDATE workflows SET lease_token = NULL, lease_expires_at = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(retryAt, message, new Date().toISOString(), id).run();
    await emitEvent(env.DB, id, "status", row.status, `此階段暫時失敗，稍後可從 ${row.status} 重試：${message}`);
    return { status: 503, body: { id, status: row.status, retry_at: retryAt, error: message } };
  }
}

function workflowEventStream(env: Env, workflowId: string, request: Request) {
  const encoder = new TextEncoder();
  const initialCursor = Number(request.headers.get("last-event-id") || 0);
  return new Response(new ReadableStream({
    async start(controller) {
      let cursor = initialCursor;
      try {
        for (let attempts = 0; attempts < 900; attempts += 1) {
          const result = await env.DB.prepare("SELECT sequence, type, phase, content, created_at FROM workflow_events WHERE workflow_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 100")
            .bind(workflowId, cursor).all<{ sequence: number; type: string; phase: string; content: string; created_at: string }>();
          for (const event of result.results || []) {
            cursor = event.sequence;
            controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          const workflow = await env.DB.prepare("SELECT status FROM workflows WHERE id = ?").bind(workflowId).first<{ status: string }>();
          if (!workflow || (["finalized", "failed"].includes(workflow.status) && !(result.results || []).length)) break;
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ content: error instanceof Error ? error.message : String(error) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  }), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function handleApi(request: Request, env: Env) {
  await ensureDb(env.DB);
  const url = new URL(request.url);
  const eventMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/events$/);
  if (eventMatch && request.method === "GET") return workflowEventStream(env, eventMatch[1], request);
  if (url.pathname === "/api/workflows" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 30").all<Record<string, unknown>>();
    return json((result.results || []).map(rowToWorkflow));
  }
  if (url.pathname === "/api/workflows" && request.method === "POST") {
    const body = await request.json() as { topic?: string; brief?: string };
    const topic = body.topic?.trim();
    if (!topic) return json({ error: "請輸入關鍵字或思想" }, 400);
    if (!env.OPENAI_API_KEY || !env.TAVILY_API_KEY) return json({ error: "需要在伺服器設定 OPENAI_API_KEY 與 TAVILY_API_KEY" }, 503);
    const id = crypto.randomUUID();
    const stamp = new Date().toISOString();
    await env.DB.prepare("INSERT INTO workflows (id, topic, brief, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, topic, body.brief?.trim() || "撰寫一篇思慮嚴謹、思辨且具有洞見的繁體中文文章。", "queued", stamp, stamp).run();
    return json({ id, status: "queued" }, 202);
  }
  const advanceMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/advance$/);
  if (advanceMatch && request.method === "POST") {
    const result = await advanceWorkflow(env, advanceMatch[1]);
    return json(result.body, result.status);
  }
  const match = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (match && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM workflows WHERE id = ?").bind(match[1]).first<Record<string, unknown>>();
    return row ? json(rowToWorkflow(row)) : json({ error: "找不到任務" }, 404);
  }
  if (match && request.method === "DELETE") {
    const existing = await env.DB.prepare("SELECT id FROM workflows WHERE id = ?").bind(match[1]).first<{ id: string }>();
    if (!existing) return json({ error: "找不到任務" }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM workflow_events WHERE workflow_id = ?").bind(match[1]),
      env.DB.prepare("DELETE FROM workflows WHERE id = ?").bind(match[1]),
    ]);
    return json({ deleted: true, id: match[1] });
  }
  return json({ error: "Not found" }, 404);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
