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
type Review = { decision: "pass" | "minor_revision" | "major_revision"; summary: string; strengths: string[]; issues: ReviewIssue[]; research_queries: string[] };

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
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS workflows_updated_idx ON workflows(updated_at DESC)"),
  ]);
}

function rowToWorkflow(row: Record<string, unknown>) {
  return {
    ...row,
    sources: JSON.parse(String(row.sources_json || "[]")),
    reviews: JSON.parse(String(row.reviews_json || "[]")),
    unresolved: JSON.parse(String(row.unresolved_json || "[]")),
    sources_json: undefined,
    reviews_json: undefined,
    unresolved_json: undefined,
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

function evidencePacket(sources: Source[]) {
  return sources.map((source, index) => `SOURCE ${index + 1}\nTitle: ${source.title}\nURL: ${source.url}\nAuthority: ${source.authority}\nContent:\n${source.content}`).join("\n\n---\n\n");
}

const writerInstructions = `${writerSkill}\n\n${sourcePolicy}\n\n${argumentation}\n\nReturn JSON only. Write in Traditional Chinese unless the brief explicitly requests another language.`;
const editorInstructions = `${editorSkill}\n\n${reviewRubric}\n\nReturn JSON only. Review in Traditional Chinese.`;

async function runWorkflow(env: Env, id: string, topic: string, brief: string) {
  const now = () => new Date().toISOString();
  const updateStatus = (status: string) => env.DB.prepare("UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?").bind(status, now(), id).run();
  try {
    await updateStatus("researching");
    let sources = await tavilySearch(env, [
      `${topic} authoritative research evidence`,
      `${topic} official statistics primary sources`,
      `${topic} strongest criticism counterargument`,
      `${topic} recent systematic review expert analysis`,
    ]);

    await updateStatus("drafting");
    let article = await modelJson<WriterResult>(env, writerInstructions, `TOPIC:\n${topic}\n\nBRIEF:\n${brief}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);

    if (article.research_gaps?.length) {
      await updateStatus("researching_gaps");
      const extra = await tavilySearch(env, article.research_gaps);
      sources = [...new Map([...sources, ...extra].map((source) => [source.url, source])).values()].slice(0, 24);
      await updateStatus("redrafting_with_evidence");
      article = await modelJson<WriterResult>(env, writerInstructions, `Rewrite the draft after resolving its research gaps.\n\nTOPIC:\n${topic}\n\nBRIEF:\n${brief}\n\nPRIOR DRAFT:\n${article.markdown}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);
    }

    const reviews: Review[] = [];
    let revisionCount = 0;
    while (revisionCount < 3) {
      await updateStatus(`editing_${revisionCount + 1}`);
      const review = await modelJson<Review>(env, editorInstructions, `TOPIC:\n${topic}\n\nARTICLE:\n${article.markdown}\n\nAVAILABLE SOURCES:\n${evidencePacket(sources)}`);
      reviews.push(review);
      if (review.decision === "pass") break;
      revisionCount += 1;
      if (review.research_queries?.length) {
        const extra = await tavilySearch(env, review.research_queries);
        sources = [...new Map([...sources, ...extra].map((source) => [source.url, source])).values()].slice(0, 28);
      }
      await updateStatus(`revising_${revisionCount}`);
      article = await modelJson<WriterResult>(env, writerInstructions, `Revise the article in response to the independent editor. Preserve sound reasoning; address substantive issues. This is revision ${revisionCount} of at most 3.\n\nTOPIC:\n${topic}\n\nBRIEF:\n${brief}\n\nCURRENT ARTICLE:\n${article.markdown}\n\nEDITOR REVIEW:\n${JSON.stringify(review)}\n\nEVIDENCE CARDS:\n${evidencePacket(sources)}`);
    }

    const unresolved = [...new Set([...(article.unresolved || []), ...(reviews.at(-1)?.decision === "pass" ? [] : reviews.at(-1)?.issues.map((issue) => issue.problem) || [])])];
    await env.DB.prepare(`UPDATE workflows SET status = ?, revision_count = ?, title = ?, thesis = ?, markdown = ?, sources_json = ?, reviews_json = ?, unresolved_json = ?, updated_at = ? WHERE id = ?`)
      .bind("finalized", revisionCount, article.title, article.thesis, article.markdown, JSON.stringify(sources), JSON.stringify(reviews), JSON.stringify(unresolved), now(), id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE workflows SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind("failed", error instanceof Error ? error.message : String(error), now(), id).run();
  }
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext) {
  await ensureDb(env.DB);
  const url = new URL(request.url);
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
    ctx.waitUntil(runWorkflow(env, id, topic, body.brief || ""));
    return json({ id, status: "queued" }, 202);
  }
  const match = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (match && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM workflows WHERE id = ?").bind(match[1]).first<Record<string, unknown>>();
    return row ? json(rowToWorkflow(row)) : json({ error: "找不到任務" }, 404);
  }
  return json({ error: "Not found" }, 404);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
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
