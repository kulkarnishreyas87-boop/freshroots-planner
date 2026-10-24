"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ACTION_LABEL, FLAG_CHIP, FLAG_LABEL, fmtIST } from "@/lib/labels";
import { PHOTOS, photoUrl, productLook } from "@/lib/photos";
import { PageHero } from "@/components/PageHero";
import { toast } from "@/components/Toasts";
import { CountUp, CoverGauge, Spark } from "@/components/Viz";

interface Metrics {
  avg_12: number | null;
  avg_4: number | null;
  change_pct: number | null;
  weekly_demand: number | null;
  on_hand: number | null;
  open_po_qty: number;
  cover_weeks: number | null;
  min_weeks: number;
  max_weeks: number;
  cover_after_order: number | null;
  recent_sales: { week: string; units: number }[];
}

interface Line {
  id: number;
  sku_id: string;
  name: string;
  category: string;
  perishability: string;
  distributor_id: string;
  metrics: Metrics;
  rule_flag: string;
  rule_action: string;
  ai_flag: string | null;
  ai_high_demand: boolean | null;
  ai_action: string | null;
  ai_reason: string | null;
  recommended_qty: number;
  is_exception: boolean;
  exception_reasons: string[];
  status: string;
  final_qty: number | null;
  decision_reason: string | null;
  reason_tag: string | null;
  useful: boolean | null;
  po_ref: string | null;
  po_placed_at: string | null;
  zoho_status: string | null;
  zoho_error: string | null;
}

interface Data {
  run: { id: number; trigger: string; as_of_date: string; latest_week: string; festival: boolean; model: string; summary: string; data_issues: string[]; finished_at: string; prompt_version: string | null; rubric_version: number | null; tokens_in: number | null; tokens_out: number | null; duration_ms: number | null } | null;
  lastAttempt: { id: number; status: string; error: string | null; started_at: string } | null;
  lines: Line[];
  pendingProposals: number;
  error?: string;
}

const REASON_TAGS: [string, string][] = [
  ["demand_signal", "Demand signal the data doesn't show"],
  ["distributor_scheme", "Distributor or competitor scheme"],
  ["supply_issue", "Supply or lead-time issue"],
  ["data_wrong", "The data is wrong"],
  ["other", "Other"],
];

const flagOf = (l: Line) => l.ai_flag ?? l.rule_flag;
const short = (n: string) => n.replace(/^Freshroots /, "");

/** Queue groups, in the order Raghav should work through them. */
function groupOf(l: Line): string {
  if (l.status !== "pending") return "Decided";
  if (l.is_exception) return "Needs your judgment";
  const f = flagOf(l);
  return f === "STOCKOUT_RISK" ? "Stockout risk" : f === "OVERSTOCK_RISK" ? "Overstock risk" : "Within window";
}
const GROUPS = ["Needs your judgment", "Stockout risk", "Overstock risk", "Within window", "Decided"];

function greeting(): string {
  const h = Number(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function ReviewPage() {
  const [data, setData] = useState<Data | null>(null);
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/recommendations", { cache: "no-store" });
      setData(await res.json());
    } catch {
      toast("Could not reach the server. Retrying in a minute.", "warn");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const ordered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = lines.filter((l) => !needle || `${l.name} ${l.sku_id} ${l.category} ${l.distributor_id}`.toLowerCase().includes(needle));
    return GROUPS.flatMap((g) => list.filter((l) => groupOf(l) === g));
  }, [lines, q]);

  // Keep a valid selection: first waiting line by default.
  useEffect(() => {
    if (!ordered.length) return;
    if (selId === null || !ordered.some((l) => l.id === selId)) setSelId((ordered.find((l) => l.status === "pending") ?? ordered[0]).id);
  }, [ordered, selId]);

  const sel = ordered.find((l) => l.id === selId) ?? null;
  const move = useCallback((dir: 1 | -1) => {
    if (!ordered.length) return;
    const i = Math.max(0, ordered.findIndex((l) => l.id === selId));
    setSelId(ordered[Math.min(ordered.length - 1, Math.max(0, i + dir))].id);
  }, [ordered, selId]);

  const nextPending = useCallback((afterId: number) => {
    const i = ordered.findIndex((l) => l.id === afterId);
    const rest = [...ordered.slice(i + 1), ...ordered.slice(0, i)];
    const n = rest.find((l) => l.status === "pending");
    if (n) setSelId(n.id);
  }, [ordered]);

  // Keyboard: J/K move, / search. A and R are handled by the detail panel.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select");
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [move]);

  // Bring the selected row into view in the queue.
  useEffect(() => {
    if (selId !== null) document.getElementById(`q-${selId}`)?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  async function runNow() {
    setRunning(true);
    toast("Run started: checking data, then Gemini plans every SKU…");
    const res = await fetch("/api/run", { method: "POST" });
    const json = await res.json();
    setRunning(false);
    toast(json.message, json.status === "done" ? "ok" : json.status === "failed" ? "err" : "warn");
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  async function bulkApprove() {
    if (!data?.run) return;
    const res = await fetch("/api/recommendations/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: data.run.id }) });
    const json = await res.json();
    if (!res.ok) return toast(json.error, "err");
    toast(`Approved ${json.approved} routine lines.`);
    load();
  }

  const counts = useMemo(() => ({
    exc: lines.filter((l) => groupOf(l) === "Needs your judgment").length,
    stockout: lines.filter((l) => flagOf(l) === "STOCKOUT_RISK").length,
    over: lines.filter((l) => flagOf(l) === "OVERSTOCK_RISK").length,
    ok: lines.filter((l) => flagOf(l) === "OK").length,
    pending: lines.filter((l) => l.status === "pending").length,
    approved: lines.filter((l) => l.status === "approved").length,
    rejected: lines.filter((l) => l.status === "rejected").length,
    routine: lines.filter((l) => l.status === "pending" && !l.is_exception && l.perishability !== "High").length,
    toOrder: lines.filter((l) => l.status === "approved" && (l.final_qty ?? 0) > 0 && !l.po_ref).length,
  }), [lines]);

  if (!data) {
    return (
      <>
        <div className="skel" style={{ height: 150, borderRadius: 18 }} />
        <div className="stats">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 86 }} />)}</div>
        <div className="triage"><div className="skel" style={{ height: 420 }} /><div className="skel" style={{ height: 420 }} /></div>
      </>
    );
  }
  if (data.error) return <div className="banner red"><b>Could not load the review queue.</b><p>{data.error}</p></div>;

  const total = lines.length || 1;
  const blocked = data.lastAttempt && ["failed", "blocked_data"].includes(data.lastAttempt.status) ? data.lastAttempt : null;

  return (
    <>
      <PageHero
        compact
        photo={PHOTOS.warehouse}
        eyebrow="Review · Raghav's decisions"
        title={<>{greeting()}, Raghav. {counts.pending ? `${counts.pending} line${counts.pending === 1 ? "" : "s"} waiting.` : "All decided."}</>}
        actions={
          <>
            <button className="btn primary" onClick={runNow} disabled={running}>{running ? <><span className="spinner" /> Planning…</> : "Run now"}</button>
            <a className="btn" href="/api/export">Export lines without a PO ({counts.toOrder})</a>
            {data.pendingProposals > 0 && <Link className="btn" href="/learning">◆ {data.pendingProposals} lesson{data.pendingProposals === 1 ? "" : "s"} to review</Link>}
          </>
        }
      >
        {data.run ? <p>{data.run.summary}</p> : <p>No run yet. Load the exports on the Data page, then press Run now.</p>}
      </PageHero>

      {blocked && (
        <div className="banner red">
          <b>{blocked.status === "blocked_data" ? "The data gate stopped the last run" : "The last run failed"} ({fmtIST(blocked.started_at)}).</b>
          <p>{blocked.error}</p>
          {blocked.status === "blocked_data" && <p className="small">Fix it on the <Link href="/data">Data page</Link>, then press Run now. The queue below is from the last good run.</p>}
        </div>
      )}

      {data.run && (
        <>
          <div className="stats">
            <div className="stat plum static"><b><CountUp value={counts.exc} /></b><span>Need your judgment</span><small>exceptions, waiting</small></div>
            <div className="stat red static"><b><CountUp value={counts.stockout} /></b><span>Stockout risk</span><small>below minimum cover</small></div>
            <div className="stat amber static"><b><CountUp value={counts.over} /></b><span>Overstock risk</span><small>above maximum cover</small></div>
            <div className="stat green static"><b><CountUp value={counts.ok} /></b><span>Within window</span><small>no action needed</small></div>
            <div className="stat blue static">
              <b><CountUp value={counts.approved + counts.rejected} /><small style={{ fontSize: "1rem" }}> / {lines.length}</small></b>
              <span>Decided</span>
              <div className="progress" aria-label={`${counts.approved} approved, ${counts.rejected} rejected`}>
                <i style={{ width: `${(counts.approved / total) * 100}%`, background: "var(--green)" }} />
                <i style={{ width: `${(counts.rejected / total) * 100}%`, background: "var(--red)" }} />
              </div>
            </div>
          </div>

          <div className="triage">
            <aside className="queue" aria-label="Review queue">
              <div className="queue-head">
                <input ref={searchRef} id="search" type="search" aria-label="Search the queue" placeholder="Search product or SKU   ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="row between small muted">
                  <span><span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">A</span> approve · <span className="kbd">R</span> reject</span>
                  <button className="btn" style={{ padding: "4px 10px", fontSize: "0.8rem" }} onClick={bulkApprove} disabled={counts.routine === 0} title="Exceptions and fresh SKUs are always decided one by one">✓ {counts.routine} routine</button>
                </div>
              </div>
              <div className="queue-list">
                {GROUPS.map((g) => {
                  const rows = ordered.filter((l) => groupOf(l) === g);
                  if (!rows.length) return null;
                  return (
                    <div key={g}>
                      <div className="queue-group"><span>{g}</span><span>{rows.length}</span></div>
                      {rows.map((l) => {
                        const look = productLook(l.name, l.category);
                        const f = flagOf(l);
                        return (
                          <button key={l.id} id={`q-${l.id}`} className={`qrow ${l.id === selId ? "sel" : ""} ${l.status !== "pending" ? "decided" : ""}`} style={{ ["--cat" as string]: look.color }} onClick={() => setSelId(l.id)} aria-current={l.id === selId}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={photoUrl(look.photo, 96, 96)} alt="" loading="lazy" />
                            <div style={{ minWidth: 0 }}>
                              <div className="qname">{short(l.name)}</div>
                              <div className="qsub">{l.status === "pending" ? `${ACTION_LABEL[l.ai_action ?? l.rule_action]}${l.recommended_qty ? ` · ${l.recommended_qty}` : ""} · ${l.metrics.cover_weeks ?? "—"} wk` : `${l.status}${l.final_qty ? ` · ${l.final_qty}` : ""}${l.po_ref ? ` · ${l.po_ref}` : ""}`}</div>
                            </div>
                            <span className="qstate" aria-label={l.status === "pending" ? FLAG_LABEL[f] : l.status}>
                              {l.status === "approved" ? "✅" : l.status === "rejected" ? "⛔" : !l.ai_flag && l.metrics.cover_weeks === null
                                ? <span className="chip c-plum" style={{ padding: "2px 6px" }}>DATA</span>
                                : <span className={`chip ${FLAG_CHIP[f]}`} style={{ padding: "2px 6px" }}>{f === "STOCKOUT_RISK" ? "LOW" : f === "OVERSTOCK_RISK" ? "HIGH" : "OK"}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {ordered.length === 0 && <p className="muted small" style={{ padding: 12 }}>Nothing matches “{q}”.</p>}
              </div>
            </aside>

            {sel ? <Detail key={sel.id} line={sel} onDone={(id) => { load(); nextPending(id); }} onChange={load} /> : <div className="card"><p className="muted">Select a line.</p></div>}
          </div>

          <p className="small muted">
            Run #{data.run.id} ({data.run.trigger}) · sales to {data.run.latest_week} · stock as of {data.run.as_of_date}{data.run.festival ? " · festival uplift on" : ""} · {data.run.model} · prompt {data.run.prompt_version ?? "—"} · rules v{data.run.rubric_version ?? "—"}
            {data.run.tokens_in ? ` · ${data.run.tokens_in + (data.run.tokens_out ?? 0)} tokens` : ""}{data.run.duration_ms ? ` · ${(data.run.duration_ms / 1000).toFixed(1)} s` : ""} · finished {fmtIST(data.run.finished_at)}
          </p>
          {data.run.data_issues?.length ? <ul className="exc-list">{data.run.data_issues.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </>
      )}
    </>
  );
}

function Detail({ line, onDone, onChange }: { line: Line; onDone: (id: number) => void; onChange: () => void }) {
  const [qty, setQty] = useState(String(line.recommended_qty));
  const [reason, setReason] = useState("");
  const [tag, setTag] = useState("demand_signal");
  const [poRef, setPoRef] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const m = line.metrics;
  const flag = flagOf(line);
  const action = line.ai_action ?? line.rule_action;
  const disagree = line.ai_flag !== null && (line.ai_flag !== line.rule_flag || line.ai_action !== line.rule_action);
  const look = productLook(line.name, line.category);
  const needsReason = line.status === "pending" && (Number(qty) !== line.recommended_qty);

  const post = useCallback(async (url: string, body: unknown, success: string, advance: boolean) => {
    setBusy(true);
    setErr("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? json.message); return toast(json.error ?? json.message, "err"); }
    const po = json.po as { status: string; message: string } | null | undefined;
    toast(po && po.status !== "skipped" ? `${success} ${po.message}` : success, po?.status === "failed" ? "warn" : "ok");
    window.dispatchEvent(new Event("killswitch-changed"));
    if (advance) onDone(line.id); else onChange();
  }, [line.id, onDone, onChange]);

  const approve = useCallback(() => post(`/api/recommendations/${line.id}/decision`, { decision: "approve", qty: Number(qty), reason, reasonTag: tag }, `Approved ${short(line.name)}.`, true), [post, line.id, line.name, qty, reason, tag]);
  const reject = useCallback(() => {
    if (!reason.trim()) { reasonRef.current?.focus(); return toast("Add a reason to reject.", "warn"); }
    post(`/api/recommendations/${line.id}/decision`, { decision: "reject", reason, reasonTag: tag }, `Rejected ${short(line.name)}.`, true);
  }, [post, line.id, line.name, reason, tag]);

  // A approves, R rejects (or jumps to the reason box first).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey || busy || line.status !== "pending") return;
      if (e.key === "a") { e.preventDefault(); approve(); }
      if (e.key === "r") { e.preventDefault(); reject(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [approve, reject, busy, line.status]);

  return (
    <section className="detail" aria-label={`Detail for ${line.name}`}>
      <div className="detail-top" style={{ ["--cat" as string]: look.color }}>
        <div className="detail-photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(look.photo, 420, 400)} alt={look.photo.alt} />
          <span className="cat">{look.label}</span>
          <span className="credit">Photo: <a href={look.photo.page} target="_blank" rel="noreferrer">{look.photo.by}</a> / Unsplash</span>
        </div>
        <div className="detail-head">
          <div className="row">
            <h2 style={{ fontSize: "1.3rem" }}>{short(line.name)}</h2>
            <span className="mono small muted">{line.sku_id} · {line.distributor_id}</span>
            {line.perishability === "High" && <span className="chip c-blue">❄ Fresh</span>}
            {line.is_exception && <span className="chip c-plum">◆ Exception</span>}
          </div>
          <div className="verdict">
            <span className={`chip ${FLAG_CHIP[flag]}`}>{FLAG_LABEL[flag]}</span>
            {line.ai_high_demand && <span className="chip c-blue">▲ High demand</span>}
            <span className="act">{ACTION_LABEL[action]}</span>
            {line.recommended_qty > 0 && <span className="qty">{line.recommended_qty} units</span>}
          </div>
          {line.ai_reason ? <p className="reason"><b>GEMINI</b><span>{line.ai_reason}</span></p> : <p className="reason" style={{ background: "var(--plum-soft)" }}><b style={{ color: "var(--plum)" }}>NOT DECIDED</b><span>Gemini was not asked about this line.</span></p>}
          {disagree && <p className="small muted">Rule check disagrees: {FLAG_LABEL[line.rule_flag]} · {ACTION_LABEL[line.rule_action]}</p>}
        </div>
      </div>

      {line.exception_reasons.length > 0 && <ul className="exc-list">{line.exception_reasons.map((e, i) => <li key={i}>{e}</li>)}</ul>}

      <div className="card">
        <div className="row between"><h3>Weeks of cover</h3><span className="small muted">dark = now{line.recommended_qty > 0 ? " · green = after this order" : ""}</span></div>
        <CoverGauge cover={m.cover_weeks} min={m.min_weeks} max={m.max_weeks} after={line.recommended_qty > 0 ? m.cover_after_order : null} />
        <div className="nums">
          <div className="num"><span>Cover now</span><b>{m.cover_weeks ?? "—"} wk</b></div>
          <div className="num"><span>After order</span><b>{line.recommended_qty > 0 ? `${m.cover_after_order ?? "—"} wk` : "—"}</b></div>
          <div className="num"><span>Last 4 vs 12 wk</span><b className={m.change_pct === null ? "" : m.change_pct > 0 ? "up" : m.change_pct < 0 ? "down" : ""}>{m.change_pct === null ? "—" : `${m.change_pct > 0 ? "▲ +" : m.change_pct < 0 ? "▼ " : ""}${m.change_pct}%`}</b></div>
          <div className="num"><span>Weekly demand</span><b>{m.weekly_demand ?? "—"}</b></div>
          <div className="num"><span>On hand + on order</span><b>{m.on_hand ?? "—"}{m.open_po_qty ? ` + ${m.open_po_qty}` : ""}</b></div>
        </div>
        <div className="row between"><span className="small muted">Weekly sales, last 16 weeks</span><Spark data={m.recent_sales} color={look.color} /></div>
      </div>

      <div className="card">
        {line.status === "pending" ? (
          <>
            <h3>Your decision</h3>
            <div className="decide" style={{ borderTop: 0, paddingTop: 0 }}>
              <label>Quantity
                <input id={`qty-${line.id}`} type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>
              <label>Why (if you change it)
                <select id={`tag-${line.id}`} value={tag} onChange={(e) => setTag(e.target.value)}>
                  {REASON_TAGS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="reason-in">Reason {needsReason ? <span className="error">(needed for a new quantity)</span> : <span className="muted">(needed to reject)</span>}
                <input ref={reasonRef} id={`reason-${line.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Distributor scheme ends this week" />
              </label>
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={approve}>✓ Approve{Number(qty) > 0 ? ` ${qty}` : ""} <span className="kbd" style={{ background: "transparent", color: "inherit" }}>A</span></button>
              <button className="btn danger" disabled={busy} onClick={reject}>✕ Reject <span className="kbd">R</span></button>
            </div>
          </>
        ) : (
          <>
            <div className="row">
              <h3>Decision</h3>
              <span className={`chip ${line.status === "approved" ? "c-green" : line.status === "rejected" ? "c-red" : "c-grey"}`}>{line.status}</span>
              {line.status === "approved" && <span className="small">{line.final_qty} units</span>}
              {line.decision_reason && <span className="small muted">“{line.decision_reason}”</span>}
            </div>
            {line.status === "approved" && (line.final_qty ?? 0) > 0 && (line.po_ref ? (
              <span className="chip c-green">{line.zoho_status === "created" ? "Raised in Zoho: " : "PO "}{line.po_ref} · {fmtIST(line.po_placed_at)}</span>
            ) : line.zoho_status === "creating" ? (
              <span className="chip c-grey"><span className="spinner" /> Raising PO in Zoho…</span>
            ) : (
              <div className="row">
                {line.zoho_status === "failed" && <button className="btn primary" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/zoho-po`, {}, "Retried.", false)}>Retry Zoho PO</button>}
                <input id={`po-${line.id}`} aria-label="PO number raised by hand" placeholder="PO no. raised by hand" value={poRef} onChange={(e) => setPoRef(e.target.value)} />
                <button className="btn" disabled={busy || !poRef.trim()} onClick={() => post(`/api/recommendations/${line.id}/po`, { poRef }, `PO ${poRef} recorded.`, false)}>Record PO</button>
              </div>
            ))}
            {line.zoho_error && !line.po_ref && <p className="error">Zoho PO not raised: {line.zoho_error}</p>}
          </>
        )}
        <div className="row" style={{ borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
          <span className="small muted">Was this recommendation useful?</span>
          <div className="seg" role="group" aria-label="Was this useful">
            <button className={line.useful === true ? "on" : ""} onClick={() => post(`/api/recommendations/${line.id}/feedback`, { useful: true }, "Thanks: noted as useful.", false)}>👍 Yes</button>
            <button className={line.useful === false ? "on" : ""} onClick={() => post(`/api/recommendations/${line.id}/feedback`, { useful: false }, "Noted as not useful.", false)}>👎 No</button>
          </div>
        </div>
        {err && <p className="error">{err}</p>}
      </div>
    </section>
  );
}
