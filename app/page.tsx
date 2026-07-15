"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Source = { title: string; url: string; authority: string };
type Review = { decision: string; summary: string; strengths: string[]; issues: Array<{ severity: string; category: string; problem: string; required_change: string }> };
type Workflow = {
  id: string; topic: string; brief: string; status: string; revision_count: number; title?: string; thesis?: string;
  markdown?: string; sources: Source[]; reviews: Review[]; unresolved: string[]; error?: string; updated_at: string;
};
type LiveEvent = { sequence: number; type: string; phase: string; content: string; created_at: string };

const statusLabel: Record<string, string> = {
  queued: "排程中", researching: "研究資料", drafting: "撰寫初稿", researching_gaps: "補查疑點",
  redrafting_with_evidence: "整合補充證據", finalized: "已定稿", failed: "執行失敗",
};

function labelStatus(status: string) {
  if (status.startsWith("editing_")) return `總編審稿 ${status.split("_")[1]}`;
  if (status.startsWith("researching_revision_")) return `修訂補查 ${status.split("_")[2]}`;
  if (status.startsWith("revising_")) return `作者修訂 ${status.split("_")[1]}`;
  return statusLabel[status] || status;
}

export default function Home() {
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("以繁體中文撰寫約 1800–2500 字的深度文章；兼顧反方觀點，清楚區分事實與推論。");
  const [items, setItems] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [liveDraft, setLiveDraft] = useState("");
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const advancing = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workflows", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as Workflow[];
      setItems(data);
      setSelectedId((current) => current && data.some((item) => item.id === current) ? current : data[0]?.id);
    } catch { /* local preview may not have D1 ready yet */ }
  }, []);

  useEffect(() => { const initial = window.setTimeout(load, 0); const timer = setInterval(load, 4000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [load]);
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);

  useEffect(() => {
    const next = items.find((item) => !["finalized", "failed"].includes(item.status) && !advancing.current.has(item.id));
    if (!next) return;
    const timer = window.setTimeout(async () => {
      advancing.current.add(next.id);
      try {
        const response = await fetch(`/api/workflows/${next.id}/advance`, { method: "POST" });
        if (response.status !== 202) await load();
      } finally {
        advancing.current.delete(next.id);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [items, load]);

  useEffect(() => {
    if (!selectedId) return;
    const reset = window.setTimeout(() => { setLiveDraft(""); setLiveEvents([]); }, 0);
    const stream = new EventSource(`/api/workflows/${selectedId}/events`);
    const receive = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;
      const item = JSON.parse(event.data) as LiveEvent;
      setLiveEvents((current) => current.some((entry) => entry.sequence === item.sequence) ? current : [...current, item]);
      if (item.type === "draft_reset") setLiveDraft("");
      if (item.type === "draft_delta") setLiveDraft((current) => current + item.content);
      if (item.type === "completed" || item.type === "error") { stream.close(); load(); }
    };
    ["status", "research", "draft_reset", "draft_delta", "review", "completed", "error"].forEach((type) => stream.addEventListener(type, receive));
    return () => { clearTimeout(reset); stream.close(); };
  }, [load, selectedId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic, brief }) });
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "無法建立任務");
      setTopic(""); setSelectedId(data.id); setMessage("任務已建立，研究代理正在工作。"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function downloadMarkdown() {
    if (!selected?.markdown) return;
    const blob = new Blob([selected.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${selected.title || "article"}.md`; anchor.click(); URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="masthead">
        <a className="brand" href="#top" aria-label="Insight Writing Lab 首頁"><span>I</span> Insight Writing Lab</a>
        <nav><a href="#studio">寫作室</a><a href="#archive">文章庫</a><span className="system-dot">雙代理在線</span></nav>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">RESEARCH × WRITING × INDEPENDENT EDITING</div>
        <h1>讓一個念頭，經得起<br/><em>證據與反對意見。</em></h1>
        <p>輸入關鍵字或尚未成形的思想。寫作者會主動研究，總編輯會獨立質疑；最多三輪，留下可追溯的 Markdown 定稿。</p>
        <div className="principles"><span>01&nbsp; 權威來源</span><span>02&nbsp; 獨立審稿</span><span>03&nbsp; 三輪上限</span></div>
      </section>

      <section className="studio" id="studio">
        <form className="composer" onSubmit={submit}>
          <div className="section-kicker"><span>NEW COMMISSION</span><b>新文章委託</b></div>
          <label htmlFor="topic">你想釐清什麼？</label>
          <textarea id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} required placeholder="例如：效率崇拜是否正在侵蝕我們理解世界的能力？" />
          <label htmlFor="brief">編輯備註</label>
          <textarea className="brief" id="brief" value={brief} onChange={(e) => setBrief(e.target.value)} />
          <div className="composer-foot">
            <p>寫作者遇到證據缺口時會主動使用 Tavily 補查。</p>
            <button disabled={busy}>{busy ? "建立中…" : "開始研究與寫作 →"}</button>
          </div>
          {message && <div className="notice">{message}</div>}
        </form>

        <aside className="workflow-card">
          <div className="section-kicker"><span>EDITORIAL PROTOCOL</span><b>編輯流程</b></div>
          {[["研究", "Tavily 搜尋、擷取與來源分級"], ["初稿", "論點、反證與引用一次成形"], ["獨立總編", "不預設作者結論正確"], ["最多三輪", "程式強制停止，未解問題保留"]].map((step, index) => (
            <div className="protocol" key={step[0]}><i>{String(index + 1).padStart(2, "0")}</i><div><strong>{step[0]}</strong><small>{step[1]}</small></div></div>
          ))}
        </aside>
      </section>

      <section className="archive" id="archive">
        <div className="archive-head"><div><span>SHARED ARCHIVE</span><h2>文章與審稿紀錄</h2></div><p>{items.length} 篇委託</p></div>
        <div className="workspace">
          <div className="task-list">
            {items.length === 0 && <div className="empty"><b>尚無文章</b><span>建立第一個寫作委託後，所有版本會出現在這裡。</span></div>}
            {items.map((item) => <button className={item.id === selectedId ? "task active" : "task"} key={item.id} onClick={() => setSelectedId(item.id)}>
              <span className={`status ${item.status}`}>{labelStatus(item.status)}</span>
              <strong>{item.title || item.topic}</strong>
              <small>{new Date(item.updated_at).toLocaleString("zh-TW")} · 修訂 {item.revision_count || 0}/3</small>
            </button>)}
          </div>

          <article className="reader">
            {!selected && <div className="reader-placeholder"><span>¶</span><h3>選擇一篇文章</h3><p>查看定稿、研究來源與每輪總編意見。</p></div>}
            {selected && <>
              <div className="reader-meta"><span>{labelStatus(selected.status)}</span><button onClick={downloadMarkdown} disabled={!selected.markdown}>下載 .md</button></div>
              <h2>{selected.title || selected.topic}</h2>
              {selected.thesis && <p className="thesis">{selected.thesis}</p>}
              {selected.error && <div className="error">{selected.error}</div>}
              {!selected.markdown && liveEvents.length > 0 && <div className="live-panel">
                <div className="live-head"><span><i></i> LIVE</span><b>寫作動態</b></div>
                <ol>{liveEvents.filter((event) => event.type !== "draft_delta" && event.type !== "draft_reset").slice(-6).map((event) => {
                  let content = event.content;
                  try { const parsed = JSON.parse(content) as { message?: string; summary?: string; decision?: string }; content = parsed.message || parsed.summary || parsed.decision || content; } catch { /* plain event text */ }
                  return <li key={event.sequence}><time>{new Date(event.created_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{content}</span></li>;
                })}</ol>
              </div>}
              {selected.markdown ? <pre className="markdown">{selected.markdown}</pre> : liveDraft ? <pre className="markdown live-draft">{liveDraft}<span className="typing-cursor">▍</span></pre> : <div className="working"><i></i><p>代理正在處理：{labelStatus(selected.status)}</p></div>}
              {(selected.sources?.length > 0 || selected.reviews?.length > 0) && <div className="evidence-grid">
                <section><h3>研究來源 <span>{selected.sources.length}</span></h3>{selected.sources.slice(0, 10).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><b>{source.title}</b><small>{source.authority}</small></a>)}</section>
                <section><h3>總編紀錄 <span>{selected.reviews.length}</span></h3>{selected.reviews.map((review, index) => <details key={index} open={index === selected.reviews.length - 1}><summary>第 {index + 1} 輪 · {review.decision}</summary><p>{review.summary}</p>{review.issues?.map((issue, i) => <p className="issue" key={i}><b>{issue.category}</b>{issue.problem}</p>)}</details>)}</section>
              </div>}
            </>}
          </article>
        </div>
      </section>

      <footer><span>Insight Writing Lab</span><p>Skills 定義思考方法；程式守住流程與三輪上限。</p></footer>
    </main>
  );
}
