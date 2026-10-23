"use client";

import { useCallback, useEffect, useState } from "react";
import { ACTION_LABEL, FLAG_CHIP, FLAG_LABEL, fmtIST } from "@/lib/labels";
import { categoryLook, photoUrl, PHOTOS } from "@/lib/photos";
import { PageHero } from "@/components/PageHero";
import { toast } from "@/components/Toasts";
import { CountUp, CoverGauge } from "@/components/Viz";

interface StatusData {
  killSwitch: { paused: boolean; reason: string | null };
  rejects: { windowDays: number; decided: number; rejected: number; rejectRatePct: number | null };
  killLimits: { pct: number; minDecisions: number; days: number };
  lag: { avgDays: number | null; pos: number };
  skus: { id: number; sku_id: string; name: string; category: string; perishability: string; latest_week: string; flag: string; action: string; recommended_qty: number; status: string; final_qty: number | null; po_ref: string | null; po_placed_at: string | null; cover_weeks: number | null; min_weeks: number; max_weeks: number }[];
  runs: { id: number; trigger: string; status: string; latest_week: string | null; error: string | null; started_at: string }[];
  stockouts: { id: number; sku_id: string; name: string; note: string | null; reported_at: string }[];
  error?: string;
}

export default function StatusPage() {
  const [d, setD] = useState<StatusData | null>(null);
  const [sku, setSku] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => setD(await (await fetch("/api/status", { cache: "no-store" })).json()), []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function report() {
    const res = await fetch("/api/stockouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skuId: sku, note }) });
    const json = await res.json();
    if (!res.ok) return toast(json.error, "err");
    toast(json.killSwitch?.paused ? "Stockout recorded. The kill switch tripped: runs are paused." : `Stockout recorded for ${sku}.`, json.killSwitch?.paused ? "warn" : "ok");
    setNote("");
    window.dispatchEvent(new Event("killswitch-changed"));
    load();
  }

  if (!d) return <><div className="skel" style={{ height: 210, borderRadius: 18 }} /><div className="stats">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 96 }} />)}</div></>;
  if (d.error) return <div className="banner red"><b>Could not load status.</b><p>{d.error}</p></div>;

  const n = d.skus.length || 1;
  const mix = [
    { key: "STOCKOUT_RISK", color: "var(--red)", count: d.skus.filter((s) => s.flag === "STOCKOUT_RISK").length },
    { key: "OVERSTOCK_RISK", color: "var(--amber)", count: d.skus.filter((s) => s.flag === "OVERSTOCK_RISK").length },
    { key: "OK", color: "var(--green)", count: d.skus.filter((s) => s.flag === "OK").length },
  ];
  const placed = d.skus.filter((s) => s.po_ref).length;
  const rateTone = d.rejects.rejectRatePct === null ? "blue" : d.rejects.rejectRatePct > d.killLimits.pct ? "red" : d.rejects.rejectRatePct > d.killLimits.pct * 0.6 ? "amber" : "green";

  return (
    <>
      <PageHero photo={PHOTOS.shelves} eyebrow="Dashboard · Status" title="Where every SKU stands">
        <p>Deepa&apos;s view: flags from the latest run, Raghav&apos;s decisions, POs, and the guardrails.</p>
      </PageHero>

      <div className="stats">
        <div className={`stat static ${d.killSwitch.paused ? "red" : "green"}`}>
          <b style={{ fontSize: "1.3rem" }}>{d.killSwitch.paused ? "● Paused" : "● Active"}</b>
          <span>Kill switch {d.killSwitch.paused ? "on" : "off"}</span>
          <small>Trips above {d.killLimits.pct}% rejects (min {d.killLimits.minDecisions} in {d.killLimits.days} days) or a fresh OK SKU running out.</small>
        </div>
        <div className={`stat static ${rateTone}`}>
          <b>{d.rejects.rejectRatePct === null ? "—" : <><CountUp value={Math.round(d.rejects.rejectRatePct)} />%</>}</b>
          <span>Reject rate, {d.rejects.windowDays} days</span>
          <small>{d.rejects.rejected} rejected of {d.rejects.decided} decided · limit {d.killLimits.pct}%</small>
        </div>
        <div className="stat static blue">
          <b>{d.lag.avgDays === null ? "—" : d.lag.avgDays}<small style={{ fontSize: "1rem" }}>{d.lag.avgDays === null ? "" : " days"}</small></b>
          <span>Sales week to PO</span>
          <small>{d.lag.pos ? `Average of ${d.lag.pos} PO${d.lag.pos === 1 ? "" : "s"}, 90 days.` : "No POs yet."} Manual process: 21–28 days.</small>
        </div>
        <div className="stat static plum">
          <b><CountUp value={placed} /><small style={{ fontSize: "1rem" }}> / {d.skus.length}</small></b>
          <span>SKUs with a PO</span>
          <small>Write-offs aren&apos;t tracked: no write-off data source yet.</small>
        </div>
      </div>

      <div className="card">
        <div className="row between"><h2>Flag mix, latest run</h2><span className="small muted">{d.skus[0]?.latest_week ? `Sales to ${d.skus[0].latest_week}` : ""}</span></div>
        <div className="progress" style={{ height: 16 }}>
          {mix.map((x) => <i key={x.key} style={{ width: `${(x.count / n) * 100}%`, background: x.color }} title={`${FLAG_LABEL[x.key]}: ${x.count}`} />)}
        </div>
        <div className="row small">
          {mix.map((x) => <span key={x.key} className="row" style={{ gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: x.color, display: "inline-block" }} />{FLAG_LABEL[x.key]} <b>{x.count}</b></span>)}
        </div>
      </div>

      <div className="card">
        <h2>SKUs</h2>
        <div className="tbl">
          <table>
            <thead><tr><th>Product</th><th>Flag</th><th>Action</th><th style={{ minWidth: 190 }}>Cover vs window</th><th>Decision</th><th className="n">Qty</th><th>PO</th></tr></thead>
            <tbody>
              {d.skus.map((s) => {
                const look = categoryLook(s.category);
                return (
                  <tr key={s.id}>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="thumb" style={{ ["--cat" as string]: look.color }} src={photoUrl(look.photo, 80, 80)} alt="" loading="lazy" />
                        <div><div>{s.name.replace(/^Freshroots /, "")}{s.perishability === "High" && <> <span className="chip c-blue">❄</span></>}</div><div className="mono small muted">{s.sku_id} · {look.label}</div></div>
                      </div>
                    </td>
                    <td><span className={`chip ${FLAG_CHIP[s.flag]}`}>{FLAG_LABEL[s.flag]}</span></td>
                    <td>{ACTION_LABEL[s.action]}</td>
                    <td><CoverGauge cover={s.cover_weeks} min={s.min_weeks} max={s.max_weeks} /></td>
                    <td><span className={`chip ${s.status === "approved" ? "c-green" : s.status === "rejected" ? "c-red" : "c-grey"}`}>{s.status}</span></td>
                    <td className="n">{s.status === "approved" ? s.final_qty : s.recommended_qty || "—"}</td>
                    <td className="small">{s.po_ref ? `${s.po_ref} · ${fmtIST(s.po_placed_at)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
                    <td>{r.trigger === "cron" ? "⏰ cron" : "▶ manual"}</td>
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
