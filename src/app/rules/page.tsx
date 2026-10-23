"use client";

import { useEffect, useState } from "react";
import type { Rubric } from "@/lib/rules";
import { PageHero } from "@/components/PageHero";
import { toast } from "@/components/Toasts";
import { PHOTOS } from "@/lib/photos";

const NUM_FIELDS: { key: keyof Rubric; label: string; hint: string }[] = [
  { key: "high_demand_threshold_pct", label: "High demand above (%)", hint: "Last 4 weeks vs 12-week average" },
  { key: "high_demand_multiplier", label: "High-demand reorder multiple", hint: "× standard reorder qty" },
  { key: "low_perish_min_weeks", label: "Low perishability: min weeks", hint: "Below this = stockout risk" },
  { key: "low_perish_max_weeks", label: "Low perishability: max weeks", hint: "Above this = overstock risk" },
  { key: "high_perish_min_weeks", label: "High perishability: min weeks", hint: "Fresh SKUs" },
  { key: "high_perish_max_weeks", label: "High perishability: max weeks", hint: "Fresh SKUs" },
  { key: "festival_uplift_pct", label: "Festival uplift (%)", hint: "Applied to weekly demand" },
  { key: "avg_window_weeks", label: "Long average (weeks)", hint: "Includes the recent weeks" },
  { key: "recent_window_weeks", label: "Recent average (weeks)", hint: "" },
  { key: "borderline_pct", label: "Close call within (%)", hint: "Of a threshold, sent to Raghav" },
  { key: "kill_reject_rate_pct", label: "Kill switch: reject rate above (%)", hint: "" },
  { key: "kill_min_decisions", label: "Kill switch: min decisions", hint: "Before the rate counts" },
  { key: "kill_window_days", label: "Kill switch: window (days)", hint: "" },
];

export default function RulesPage() {
  const [r, setR] = useState<Rubric | null>(null);
  const [months, setMonths] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/rules").then((x) => x.json()).then((j) => {
      if (j.error) return setMsg({ ok: false, text: j.error });
      setR(j.rubric);
      setMonths(j.rubric.festival_months.join(", "));
    });
  }, []);

  async function save() {
    if (!r) return;
    const festival_months = months.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    const res = await fetch("/api/rules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rubric: { ...r, festival_months } }) });
    const j = await res.json();
    if (!res.ok) {
      toast(j.error, "err");
      return setMsg({ ok: false, text: j.error });
    }
    setR(j.rubric);
    setMsg({ ok: true, text: "Saved. The next run uses these rules." });
    toast("Rules saved. The next run uses them.");
  }

  if (!r) return msg ? <div className="banner red"><p>{msg.text}</p></div> : <p className="muted">Loading…</p>;

  return (
    <>
      <PageHero photo={PHOTOS.field} eyebrow="Context · Forecast logic rules (rubric)" title="Raghav's rules">
        <p>Gemini decides each SKU against these rules. The system also applies them in code and sends any disagreement to Raghav.</p>
      </PageHero>

      <div className="card">
        <div className="grid2">
          {NUM_FIELDS.map((f) => (
            <label key={f.key}>{f.label}
              <input id={`rule-${f.key}`} type="number" step="any" min={0} value={String(r[f.key])}
                onChange={(e) => setR({ ...r, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) })} />
              {f.hint && <span className="small muted" style={{ fontWeight: 400 }}>{f.hint}</span>}
            </label>
          ))}
          <label>Festival months (fallback)
            <input id="rule-festival-months" value={months} onChange={(e) => setMonths(e.target.value)} />
            <span className="small muted" style={{ fontWeight: 400 }}>Month numbers. Used only when the calendar has no row for the month.</span>
          </label>
        </div>
        <label>Raghav&apos;s judgment notes
          <textarea id="rule-notes" rows={6} value={r.judgment_notes} onChange={(e) => setR({ ...r, judgment_notes: e.target.value })}
            placeholder="Cases the rules don't cover: new launches, distributor schemes, one-off events. Gemini reads these and flags matching SKUs for you." />
        </label>
        <div className="row">
          <button className="btn primary" onClick={save}>Save rules</button>
          {msg && <span className={msg.ok ? "small" : "error"}>{msg.text}</span>}
        </div>
      </div>
    </>
  );
}
