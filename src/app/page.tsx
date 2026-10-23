"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ACTION_LABEL, FLAG_CHIP, FLAG_LABEL, fmtIST } from "@/lib/labels";
import { categoryLook, photoUrl, PHOTOS } from "@/lib/photos";
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
  po_ref: string | null;
  po_placed_at: string | null;
  zoho_status: string | null;
  zoho_error: string | null;
  zoho_reference: string | null;
}

interface Data {
  run: { id: number; trigger: string; as_of_date: string; latest_week: string; festival: boolean; model: string; summary: string; data_issues: string[]; finished_at: string } | null;
  lastAttempt: { id: number; status: string; error: string | null; started_at: string } | null;
  lines: Line[];
  error?: string;
}

type Filter = "all" | "exc" | "STOCKOUT_RISK" | "OVERSTOCK_RISK" | "OK" | "pending" | "decided";
type Sort = "urgency" | "cover" | "sku";

const flagOf = (l: Line) => l.ai_flag ?? l.rule_flag;

function greeting(): string {
  const h = Number(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function ReviewPage() {
  const [data, setData] = useState<Data | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("urgency");
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/recommendations", { cache: "no-store" });
      setData(await res.json());
      setUpdated(new Date());
    } catch {
      toast("Could not reach the server. Retrying in a minute.", "warn");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow() {
    setRunning(true);
    toast("Run started: Gemini is planning every SKU…");
    const res = await fetch("/api/run", { method: "POST" });
    const json = await res.json();
    setRunning(false);
    toast(json.message, json.status === "done" ? "ok" : json.status === "skipped_paused" ? "warn" : "err");
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  async function bulkApprove() {
    if (!data?.run) return;
    const res = await fetch("/api/recommendations/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: data.run.id }) });
    const json = await res.json();
    if (!res.ok) return toast(json.error, "err");
    const pos = (json.pos ?? []) as { status: string }[];
    const created = pos.filter((p) => p.status === "created").length;
    toast(`Approved ${json.approved} routine lines.${created ? ` ${created} POs raised in Zoho.` : ""}`);
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  const lines = data?.lines ?? [];
  const counts = useMemo(() => ({
    stockout: lines.filter((l) => flagOf(l) === "STOCKOUT_RISK").length,
    over: lines.filter((l) => flagOf(l) === "OVERSTOCK_RISK").length,
    ok: lines.filter((l) => flagOf(l) === "OK").length,
    exc: lines.filter((l) => l.is_exception && l.status === "pending").length,
    pending: lines.filter((l) => l.status === "pending").length,
    approved: lines.filter((l) => l.status === "approved").length,
    rejected: lines.filter((l) => l.status === "rejected").length,
    routine: lines.filter((l) => l.status === "pending" && !l.is_exception && l.perishability !== "High").length,
    toOrder: lines.filter((l) => l.status === "approved" && (l.final_qty ?? 0) > 0 && !l.po_ref).length,
  }), [lines]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = lines.filter((l) => {
      if (filter === "exc" && !(l.is_exception && l.status === "pending")) return false;
      if ((filter === "STOCKOUT_RISK" || filter === "OVERSTOCK_RISK" || filter === "OK") && flagOf(l) !== filter) return false;
      if (filter === "pending" && l.status !== "pending") return false;
      if (filter === "decided" && l.status === "pending") return false;
      return !needle || `${l.name} ${l.sku_id} ${l.category} ${l.distributor_id}`.toLowerCase().includes(needle);
    });
    if (sort === "cover") out.sort((a, b) => (a.metrics.cover_weeks ?? -1) - (b.metrics.cover_weeks ?? -1));
    if (sort === "sku") out.sort((a, b) => a.sku_id.localeCompare(b.sku_id));
    return out; // "urgency" keeps the server order: exceptions, stockout, overstock, OK
  }, [lines, filter, q, sort]);

  if (!data) {
    return (
      <>
        <div className="skel" style={{ height: 210, borderRadius: 18 }} />
        <div className="stats">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 86 }} />)}</div>
        {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 180 }} />)}
      </>
    );
  }
  if (data.error) return <div className="banner red"><b>Could not load the review queue.</b><p>{data.error}</p></div>;

  const total = lines.length || 1;
  const pills: { key: Filter; label: string; n?: number }[] = [
    { key: "all", label: "All", n: lines.length },
    { key: "exc", label: "Exceptions", n: counts.exc },
    { key: "STOCKOUT_RISK", label: "Stockout", n: counts.stockout },
    { key: "OVERSTOCK_RISK", label: "Overstock", n: counts.over },
    { key: "OK", label: "OK", n: counts.ok },
    { key: "pending", label: "Waiting", n: counts.pending },
    { key: "decided", label: "Decided", n: counts.approved + counts.rejected },
  ];

  return (
    <>
      <PageHero
        photo={PHOTOS.warehouse}
        eyebrow="Dashboard · Raghav's review"
        title={<>{greeting()}, Raghav.</>}
        actions={
          <>
            <button className="btn primary" onClick={runNow} disabled={running}>{running ? <><span className="spinner" /> Planning…</> : "Run now"}</button>
            <a className="btn" href="/api/export">Export lines without a PO ({counts.toOrder})</a>
          </>
        }
      >
        {data.run ? (
          <>
            <p>{data.run.summary || `${counts.pending} lines are waiting for you.`}</p>
            <div className="row">
              <span className="chip">Run #{data.run.id} · {data.run.trigger}</span>
              <span className="chip">Sales to {data.run.latest_week}</span>
              <span className="chip">Stock as of {data.run.as_of_date}</span>
              {data.run.festival && <span className="chip">✦ Festival month +uplift</span>}
              <span className="chip">{data.run.model}</span>
            </div>
          </>
        ) : (
          <p>No run yet. Load the SAP exports on the Data page, then press Run now.</p>
        )}
      </PageHero>

      {data.lastAttempt?.status === "failed" && (
        <div className="banner red"><b>The last run failed ({fmtIST(data.lastAttempt.started_at)}).</b><p>{data.lastAttempt.error}</p></div>
      )}
      {data.run?.data_issues?.length ? <ul className="exc-list">{data.run.data_issues.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}

      {data.run && (
        <>
          <div className="stats">
            <button className={`stat red ${filter === "STOCKOUT_RISK" ? "on" : ""}`} onClick={() => setFilter(filter === "STOCKOUT_RISK" ? "all" : "STOCKOUT_RISK")}>
              <b><CountUp value={counts.stockout} /></b><span>Stockout risk</span><small>below the minimum cover</small>
            </button>
            <button className={`stat amber ${filter === "OVERSTOCK_RISK" ? "on" : ""}`} onClick={() => setFilter(filter === "OVERSTOCK_RISK" ? "all" : "OVERSTOCK_RISK")}>
              <b><CountUp value={counts.over} /></b><span>Overstock risk</span><small>above the maximum cover</small>
            </button>
            <button className={`stat green ${filter === "OK" ? "on" : ""}`} onClick={() => setFilter(filter === "OK" ? "all" : "OK")}>
              <b><CountUp value={counts.ok} /></b><span>Within window</span><small>no action needed</small>
            </button>
            <button className={`stat plum ${filter === "exc" ? "on" : ""}`} onClick={() => setFilter(filter === "exc" ? "all" : "exc")}>
              <b><CountUp value={counts.exc} /></b><span>Exceptions</span><small>need your judgment</small>
            </button>
            <div className="stat blue static">
              <b><CountUp value={counts.approved + counts.rejected} /><small style={{ fontSize: "1rem" }}> / {lines.length}</small></b>
              <span>Decided</span>
              <div className="progress" aria-label={`${counts.approved} approved, ${counts.rejected} rejected, ${counts.pending} waiting`}>
                <i style={{ width: `${(counts.approved / total) * 100}%`, background: "var(--green)" }} />
                <i style={{ width: `${(counts.rejected / total) * 100}%`, background: "var(--red)" }} />
              </div>
            </div>
          </div>

          <div className="toolbar">
            {pills.map((p) => (
              <button key={p.key} className={`pill ${filter === p.key ? "on" : ""}`} onClick={() => setFilter(p.key)}>
                {p.label} <em>{p.n}</em>
              </button>
            ))}
            <label className="search" style={{ display: "block" }}>
              <input id="search" type="search" aria-label="Search SKUs" placeholder="Search product, SKU, category…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <select id="sort" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="urgency">Most urgent first</option>
              <option value="cover">Lowest cover first</option>
              <option value="sku">SKU</option>
            </select>
            <button className="btn" onClick={bulkApprove} disabled={counts.routine === 0} title="Exceptions and fresh SKUs are always decided one by one">
              ✓ Approve {counts.routine} routine
            </button>
          </div>

          <div className="row between small muted">
            <span>Showing {shown.length} of {lines.length}</span>
            <span>Auto-refreshes every minute{updated ? ` · updated ${updated.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
          </div>

          <div className="lines">
            {shown.map((l, i) => <LineCard key={l.id} line={l} index={i} onChange={load} />)}
            {shown.length === 0 && <div className="card"><p className="muted">Nothing matches this filter.</p></div>}
          </div>
        </>
      )}
    </>
  );
}

function LineCard({ line, index, onChange }: { line: Line; index: number; onChange: () => void }) {
  const [qty, setQty] = useState(String(line.recommended_qty));
  const [reason, setReason] = useState("");
  const [poRef, setPoRef] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const m = line.metrics;
  const flag = flagOf(line);
  const action = line.ai_action ?? line.rule_action;
  const disagree = line.ai_flag !== null && (line.ai_flag !== line.rule_flag || line.ai_action !== line.rule_action);
  const look = categoryLook(line.category);

  async function post(url: string, body: unknown, success: string) {
    setBusy(true);
    setErr("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(json.error ?? json.message);
      return toast(json.error ?? json.message, "err");
    }
    const po = json.po as { status: string; message: string } | null | undefined;
    toast(po && po.status !== "skipped" ? `${success} ${po.message}` : success, po?.status === "failed" ? "warn" : "ok");
    window.dispatchEvent(new Event("killswitch-changed"));
    onChange();
  }

  const cls = ["card", "line", line.is_exception && line.status === "pending" ? "exc" : "", line.status !== "pending" ? "done" : ""].join(" ");

  return (
    <article className={cls} style={{ ["--i" as string]: Math.min(index, 12), ["--cat" as string]: look.color }}>
      <div className="line-photo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photoUrl(look.photo, 240, 320)} alt={look.photo.alt} loading="lazy" />
        <span className="cat">{look.label}</span>
      </div>
      <div className="line-body">
        <div className="row between">
          <div className="row">
            <h3>{line.name.replace(/^Freshroots /, "")}</h3>
            <span className="mono small muted">{line.sku_id} · {line.distributor_id}</span>
            {line.perishability === "High" && <span className="chip c-blue">❄ Fresh</span>}
            {line.is_exception && <span className="chip c-plum">◆ Exception</span>}
          </div>
          <div className="row">
            <span className={`chip ${FLAG_CHIP[flag]}`}>{FLAG_LABEL[flag]}</span>
            {line.ai_high_demand && <span className="chip c-blue">▲ High demand</span>}
            <b style={{ color: "var(--ink)" }}>{ACTION_LABEL[action]}{line.recommended_qty > 0 ? ` · ${line.recommended_qty} units` : ""}</b>
          </div>
        </div>

        <CoverGauge cover={m.cover_weeks} min={m.min_weeks} max={m.max_weeks} after={line.recommended_qty > 0 ? m.cover_after_order : null} />

        <div className="nums">
          <div className="num"><span>Weeks of cover</span><b>{m.cover_weeks ?? "—"}</b></div>
          <div className="num"><span>Last 4 vs 12 wk</span><b className={m.change_pct === null ? "" : m.change_pct > 0 ? "up" : m.change_pct < 0 ? "down" : ""}>{m.change_pct === null ? "—" : `${m.change_pct > 0 ? "▲ +" : m.change_pct < 0 ? "▼ " : ""}${m.change_pct}%`}</b></div>
          <div className="num"><span>Weekly demand</span><b>{m.weekly_demand ?? "—"}</b></div>
          <div className="num"><span>On hand + open PO</span><b>{m.on_hand ?? "—"}{m.open_po_qty ? ` + ${m.open_po_qty}` : ""}</b></div>
          <div className="num"><span>Last 16 weeks</span><Spark data={m.recent_sales} color={look.color} /></div>
        </div>

        {line.ai_reason && <p className="reason"><b>GEMINI</b><span>{line.ai_reason}</span></p>}
        {disagree && <p className="small muted">Rule check: {FLAG_LABEL[line.rule_flag]} · {ACTION_LABEL[line.rule_action]}</p>}
        {line.exception_reasons.length > 0 && <ul className="exc-list">{line.exception_reasons.map((e, i) => <li key={i}>{e}</li>)}</ul>}

        {line.status === "pending" ? (
          <div className="decide">
            <label>Qty
              <input id={`qty-${line.id}`} type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <label className="reason-in">Reason (needed to change qty or reject)
              <input id={`reason-${line.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Distributor scheme ends this week" />
            </label>
            <button className="btn primary" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/decision`, { decision: "approve", qty: Number(qty), reason }, `Approved ${line.sku_id}.`)}>✓ Approve</button>
            <button className="btn danger" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/decision`, { decision: "reject", reason }, `Rejected ${line.sku_id}.`)}>✕ Reject</button>
          </div>
        ) : (
          <div className="decide">
            <span className={`chip ${line.status === "approved" ? "c-green" : line.status === "rejected" ? "c-red" : "c-grey"}`}>{line.status === "approved" ? "✓ " : line.status === "rejected" ? "✕ " : ""}{line.status}</span>
            {line.status === "approved" && <span className="small">{line.final_qty} units</span>}
            {line.decision_reason && <span className="small muted">“{line.decision_reason}”</span>}
            {line.status === "approved" && (line.final_qty ?? 0) > 0 && (line.po_ref ? (
              <span className="chip c-green">{line.zoho_status === "created" ? "Raised in Zoho: " : "PO "}{line.po_ref} · {fmtIST(line.po_placed_at)}</span>
            ) : line.zoho_status === "creating" ? (
              <span className="chip c-grey"><span className="spinner" /> Raising PO in Zoho…</span>
            ) : (
              <>
                {line.zoho_status === "failed" && (
                  <button className="btn primary" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/zoho-po`, {}, `Retried ${line.sku_id}.`)}>Retry Zoho PO</button>
                )}
                <input id={`po-${line.id}`} aria-label="PO number raised by hand" placeholder="PO no. raised by hand" value={poRef} onChange={(e) => setPoRef(e.target.value)} />
                <button className="btn" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/po`, { poRef }, `PO ${poRef} recorded.`)}>Record PO</button>
              </>
            ))}
          </div>
        )}
        {line.zoho_error && !line.po_ref && <p className="error">Zoho PO not raised: {line.zoho_error}</p>}
        {line.zoho_error && line.po_ref && <p className="small muted">{line.zoho_error}</p>}
        {err && <p className="error">{err}</p>}
      </div>
    </article>
  );
}
