"use client";

import { useCallback, useEffect, useState } from "react";
import { ACTION_LABEL, FLAG_CHIP, FLAG_LABEL, fmtIST } from "@/lib/labels";

interface StatusData {
  killSwitch: { paused: boolean; reason: string | null };
  rejects: { windowDays: number; decided: number; rejected: number; rejectRatePct: number | null };
  killLimits: { pct: number; minDecisions: number; days: number };
  lag: { avgDays: number | null; pos: number };
  skus: { id: number; sku_id: string; name: string; perishability: string; latest_week: string; flag: string; action: string; recommended_qty: number; status: string; final_qty: number | null; po_ref: string | null; po_placed_at: string | null; cover_weeks: number | null }[];
  runs: { id: number; trigger: string; status: string; latest_week: string | null; error: string | null; started_at: string }[];
  stockouts: { id: number; sku_id: string; name: string; note: string | null; reported_at: string }[];
  error?: string;
}

export default function StatusPage() {
  const [d, setD] = useState<StatusData | null>(null);
  const [sku, setSku] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => setD(await (await fetch("/api/status", { cache: "no-store" })).json()), []);
  useEffect(() => { load(); }, [load]);

  async function report() {
    setErr("");
    const res = await fetch("/api/stockouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skuId: sku, note }) });
    const json = await res.json();
    if (!res.ok) return setErr(json.error);
    setNote("");
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  if (!d) return <p className="muted">Loading…</p>;
  if (d.error) return <div className="banner red"><b>Could not load status.</b><p>{d.error}</p></div>;

  const placed = d.skus.filter((s) => s.po_ref).length;
  return (
    <>
      <div style={{ display: "grid", gap: 4 }}>
        <span className="eyebrow">Dashboard · Status</span>
        <h1>Where every SKU stands</h1>
      </div>

      <div className="grid2">
        <div className="card">
          <span className="eyebrow">Kill switch</span>
          <h2>{d.killSwitch.paused ? "On: runs paused" : "Off: runs active"}</h2>
          <p className="small muted">Trips when Raghav rejects more than {d.killLimits.pct}% of at least {d.killLimits.minDecisions} decisions in {d.killLimits.days} days, or a fresh SKU marked OK runs out.</p>
        </div>
        <div className="card">
          <span className="eyebrow">Reject rate, last {d.rejects.windowDays} days</span>
          <h2>{d.rejects.rejectRatePct === null ? "No decisions yet" : `${d.rejects.rejectRatePct}%`}</h2>
          <p className="small muted">{d.rejects.rejected} rejected of {d.rejects.decided} decided. Limit {d.killLimits.pct}%.</p>
        </div>
        <div className="card">
          <span className="eyebrow">Sales week to PO</span>
          <h2>{d.lag.avgDays === null ? "No POs yet" : `${d.lag.avgDays} days`}</h2>
          <p className="small muted">Average over {d.lag.pos} PO{d.lag.pos === 1 ? "" : "s"} in the last 90 days. The manual process ran 21–28 days.</p>
        </div>
        <div className="card">
          <span className="eyebrow">Not tracked yet</span>
          <h2>Write-offs</h2>
          <p className="small muted">No write-off data source is connected, so write-off value is not shown.</p>
        </div>
      </div>

      <div className="card">
        <h2>SKUs · latest run</h2>
        <div className="tbl">
          <table>
            <thead><tr><th>SKU</th><th>Product</th><th>Flag</th><th>Action</th><th className="n">Cover (wks)</th><th>Decision</th><th className="n">Qty</th><th>PO</th></tr></thead>
            <tbody>
              {d.skus.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.sku_id}</td>
                  <td>{s.name}{s.perishability === "High" && <> <span className="chip c-blue">Fresh</span></>}</td>
                  <td><span className={`chip ${FLAG_CHIP[s.flag]}`}>{FLAG_LABEL[s.flag]}</span></td>
                  <td>{ACTION_LABEL[s.action]}</td>
                  <td className="n">{s.cover_weeks ?? "—"}</td>
                  <td><span className={`chip ${s.status === "approved" ? "c-green" : s.status === "rejected" ? "c-red" : "c-grey"}`}>{s.status}</span></td>
                  <td className="n">{s.status === "approved" ? s.final_qty : s.recommended_qty || "—"}</td>
                  <td>{s.po_ref ? `${s.po_ref} · ${fmtIST(s.po_placed_at)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">{placed} of {d.skus.length} SKUs have a PO recorded from the latest run.</p>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Report a stockout</h2>
          <p className="small muted">Record an SKU that actually ran out. If it is fresh and the system marked it OK, the kill switch pauses runs.</p>
          <label>SKU
            <select id="stockout-sku" value={sku} onChange={(e) => setSku(e.target.value)}>
              <option value="">Choose…</option>
              {d.skus.map((s) => <option key={s.sku_id} value={s.sku_id}>{s.sku_id} · {s.name}</option>)}
            </select>
          </label>
          <label>Note
            <input id="stockout-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where and when" />
          </label>
          <div><button className="btn danger" onClick={report} disabled={!sku}>Report stockout</button></div>
          {err && <p className="error">{err}</p>}
          {d.stockouts.length > 0 && (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {d.stockouts.map((s) => <li key={s.id}>{s.sku_id} {s.name} · {fmtIST(s.reported_at)}{s.note ? ` · ${s.note}` : ""}</li>)}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Recent runs</h2>
          <div className="tbl">
            <table>
              <thead><tr><th>#</th><th>When</th><th>Trigger</th><th>Result</th></tr></thead>
              <tbody>
                {d.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{fmtIST(r.started_at)}</td>
                    <td>{r.trigger}</td>
                    <td><span className={`chip ${r.status === "done" ? "c-green" : r.status === "failed" ? "c-red" : "c-amber"}`}>{r.status}</span>{r.error && <div className="small muted">{r.error}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
