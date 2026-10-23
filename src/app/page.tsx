"use client";

import { useCallback, useEffect, useState } from "react";
import { ACTION_LABEL, FLAG_CHIP, FLAG_LABEL, fmtIST } from "@/lib/labels";

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

export default function ReviewPage() {
  const [data, setData] = useState<Data | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ kind: "green" | "red" | "amber"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/recommendations", { cache: "no-store" });
    setData(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function runNow() {
    setRunning(true);
    setMsg(null);
    const res = await fetch("/api/run", { method: "POST" });
    const json = await res.json();
    setRunning(false);
    setMsg({ kind: json.status === "done" ? "green" : json.status === "skipped_paused" ? "amber" : "red", text: json.message });
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  async function bulkApprove() {
    if (!data?.run) return;
    const res = await fetch("/api/recommendations/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: data.run.id }) });
    const json = await res.json();
    const pos = (json.pos ?? []) as { status: string }[];
    const poText = pos.length ? ` Zoho POs: ${pos.filter((p) => p.status === "created").length} raised, ${pos.filter((p) => p.status === "failed").length} failed.` : "";
    setMsg(res.ok ? { kind: "green", text: `Approved ${json.approved} routine lines.${poText}` } : { kind: "red", text: json.error });
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;
  if (data.error) return <div className="banner red"><b>Could not load the review queue.</b><p>{data.error}</p></div>;

  const lines = data.lines;
  const pending = lines.filter((l) => l.status === "pending");
  const routine = pending.filter((l) => !l.is_exception && l.perishability !== "High").length;
  const toOrder = lines.filter((l) => l.status === "approved" && (l.final_qty ?? 0) > 0 && !l.po_ref).length;

  return (
    <>
      <div className="row between">
        <div style={{ display: "grid", gap: 4 }}>
          <span className="eyebrow">Dashboard · Raghav&apos;s review</span>
          <h1>Recommended actions</h1>
        </div>
        <div className="row">
          <a className="btn" href="/api/export">Export lines without a PO ({toOrder})</a>
          <button className="btn primary" onClick={runNow} disabled={running}>{running ? "Running…" : "Run now"}</button>
        </div>
      </div>

      {msg && <div className={`banner ${msg.kind}`}><p>{msg.text}</p></div>}

      {data.lastAttempt && data.lastAttempt.status === "failed" && (
        <div className="banner red"><b>The last run failed ({fmtIST(data.lastAttempt.started_at)}).</b><p>{data.lastAttempt.error}</p></div>
      )}

      {!data.run ? (
        <div className="card">
          <h2>No run yet</h2>
          <p className="muted">Load the SAP exports on the Data page, then press Run now. After that, the cron runs every Monday and Thursday at 7am.</p>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="row">
              <span className="chip c-grey">Run #{data.run.id} · {data.run.trigger}</span>
              <span className="chip c-grey">Sales to {data.run.latest_week}</span>
              <span className="chip c-grey">Stock as of {data.run.as_of_date}</span>
              {data.run.festival && <span className="chip c-blue">Festival month +uplift</span>}
              <span className="chip c-grey">{data.run.model}</span>
              <span className="small muted">Finished {fmtIST(data.run.finished_at)}</span>
            </div>
            {data.run.summary && <p>{data.run.summary}</p>}
            {data.run.data_issues?.length > 0 && (
              <ul className="exc-list">{data.run.data_issues.map((d, i) => <li key={i}>{d}</li>)}</ul>
            )}
            <div className="row">
              <span className="small muted">{pending.length} waiting · {lines.filter((l) => l.is_exception && l.status === "pending").length} exceptions</span>
              <button className="btn" onClick={bulkApprove} disabled={routine === 0}>Approve {routine} routine lines</button>
              <span className="small muted">Exceptions and fresh SKUs are always decided one by one.</span>
            </div>
          </div>

          {lines.map((l) => <LineCard key={l.id} line={l} onChange={load} />)}
        </>
      )}
    </>
  );
}

function Spark({ data }: { data: { week: string; units: number }[] }) {
  if (data.length < 2) return null;
  const w = 140, h = 34, max = Math.max(...data.map((d) => d.units)), min = Math.min(...data.map((d) => d.units));
  const x = (i: number) => (i / (data.length - 1)) * (w - 4) + 2;
  const y = (v: number) => (max === min ? h / 2 : h - 3 - ((v - min) / (max - min)) * (h - 6));
  const d = data.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.units).toFixed(1)}`).join(" ");
  const last = data[data.length - 1];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Weekly sales ${data[0].week} to ${last.week}: ${data.map((p) => p.units).join(", ")}`}>
      <path d={d} />
      <circle cx={x(data.length - 1)} cy={y(last.units)} r={2.5} />
    </svg>
  );
}

function LineCard({ line, onChange }: { line: Line; onChange: () => void }) {
  const [qty, setQty] = useState(String(line.recommended_qty));
  const [reason, setReason] = useState("");
  const [poRef, setPoRef] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const m = line.metrics;
  const flag = line.ai_flag ?? line.rule_flag;
  const action = line.ai_action ?? line.rule_action;
  const disagree = line.ai_flag !== null && (line.ai_flag !== line.rule_flag || line.ai_action !== line.rule_action);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setErr("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(json.error);
    window.dispatchEvent(new Event("killswitch-changed"));
    onChange();
  }

  const cls = ["card", "line", line.is_exception ? "exc" : flag === "STOCKOUT_RISK" ? "stockout" : flag === "OVERSTOCK_RISK" ? "over" : "", line.status !== "pending" ? "done" : ""].join(" ");

  return (
    <article className={cls}>
      <div className="row between">
        <div className="row">
          <h3>{line.name}</h3>
          <span className="mono small muted">{line.sku_id} · {line.distributor_id}</span>
          {line.perishability === "High" && <span className="chip c-blue">Fresh</span>}
          {line.is_exception && <span className="chip c-amber">Exception</span>}
        </div>
        <div className="row">
          <span className={`chip ${FLAG_CHIP[flag]}`}>{FLAG_LABEL[flag]}</span>
          {line.ai_high_demand && <span className="chip c-blue">High demand</span>}
          <b>{ACTION_LABEL[action]}{line.recommended_qty > 0 ? ` · ${line.recommended_qty} units` : ""}</b>
        </div>
      </div>

      <div className="nums">
        <div className="num"><span>Weeks of cover</span><b>{m.cover_weeks ?? "—"} <small className="muted">/ {m.min_weeks}–{m.max_weeks}</small></b></div>
        <div className="num"><span>Last 4 vs 12 wk</span><b>{m.change_pct === null ? "—" : `${m.change_pct > 0 ? "+" : ""}${m.change_pct}%`}</b></div>
        <div className="num"><span>Weekly demand</span><b>{m.weekly_demand ?? "—"}</b></div>
        <div className="num"><span>On hand + open PO</span><b>{m.on_hand ?? "—"}{m.open_po_qty ? ` + ${m.open_po_qty}` : ""}</b></div>
        <div className="num"><span>Cover after order</span><b>{line.recommended_qty > 0 ? m.cover_after_order ?? "—" : "—"}</b></div>
        <div className="num"><span>Last 16 weeks</span><Spark data={m.recent_sales} /></div>
      </div>

      {line.ai_reason && <p><span className="muted small">Gemini: </span>{line.ai_reason}</p>}
      {disagree && <p className="small muted">Rule check: {FLAG_LABEL[line.rule_flag]} · {ACTION_LABEL[line.rule_action]}</p>}
      {line.exception_reasons.length > 0 && (
        <ul className="exc-list">{line.exception_reasons.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}

      {line.status === "pending" ? (
        <div className="decide">
          <label>Qty
            <input id={`qty-${line.id}`} type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="reason">Reason (needed to change qty or reject)
            <input id={`reason-${line.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Distributor scheme ends this week" />
          </label>
          <button className="btn primary" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/decision`, { decision: "approve", qty: Number(qty), reason })}>Approve</button>
          <button className="btn danger" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/decision`, { decision: "reject", reason })}>Reject</button>
        </div>
      ) : (
        <div className="decide">
          <span className={`chip ${line.status === "approved" ? "c-green" : line.status === "rejected" ? "c-red" : "c-grey"}`}>{line.status}</span>
          {line.status === "approved" && <span className="small">{line.final_qty} units</span>}
          {line.decision_reason && <span className="small muted">“{line.decision_reason}”</span>}
          {line.status === "approved" && (line.final_qty ?? 0) > 0 && (line.po_ref ? (
            <span className="chip c-green">
              {line.zoho_status === "created" ? "Raised in Zoho: " : "PO "}{line.po_ref} · {fmtIST(line.po_placed_at)}
            </span>
          ) : line.zoho_status === "creating" ? (
            <span className="chip c-grey">Raising PO in Zoho…</span>
          ) : (
            <>
              {line.zoho_status === "failed" && (
                <button className="btn primary" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/zoho-po`, {})}>Retry Zoho PO</button>
              )}
              <input id={`po-${line.id}`} aria-label="PO number raised by hand" placeholder="PO no. raised by hand" value={poRef} onChange={(e) => setPoRef(e.target.value)} />
              <button className="btn" disabled={busy} onClick={() => post(`/api/recommendations/${line.id}/po`, { poRef })}>Record PO</button>
            </>
          ))}
        </div>
      )}
      {line.zoho_error && !line.po_ref && <p className="error">Zoho PO not raised: {line.zoho_error}</p>}
      {line.zoho_error && line.po_ref && <p className="small muted">{line.zoho_error}</p>}
      {err && <p className="error">{err}</p>}
    </article>
  );
}
