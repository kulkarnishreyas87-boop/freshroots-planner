"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtIST } from "@/lib/labels";
import { PHOTOS, photoUrl, productLook } from "@/lib/photos";
import { PageHero } from "@/components/PageHero";
import { toast } from "@/components/Toasts";
import { CountUp } from "@/components/Viz";

interface Proposal { id: number; kind: "lesson" | "calibration"; status: string; source: string; text: string; evidence: Record<string, unknown> | null; patch: Record<string, number> | null; created_at: string; decided_at: string | null }
interface Summary {
  scored: number;
  accuracyPct: number | null;
  verdicts: { verdict: string; label: string; n: number }[];
  demandBiasPct: number | null;
  demandAbsErrPct: number | null;
  whoWasRight: Record<string, number>;
  overrideTags: { tag: string; label: string; n: number }[];
  useful: { yes: number; no: number };
  decided: number;
  awaitingOutcome: number;
  proposals: Proposal[];
  recent: { recommendation_id: number; sku_id: string; name: string; category: string; verdict: string; stock_state: string; demand_error_pct: number | null; who_was_right: string | null; detail: string; scored_at: string; run_id: number }[];
  rubricVersions: { version: number; note: string; created_at: string }[];
  error?: string;
}

const VERDICT_TONE: Record<string, string> = { right: "c-green", missed_stockout: "c-red", short_after_order: "c-amber", false_alarm: "c-amber", missed_overstock: "c-amber", unnecessary_order: "c-amber" };
const SOURCE_LABEL: Record<string, string> = { overrides: "From Raghav's overrides", outcome: "From what happened", festival_bias: "From forecast bias", fresh_short: "From fresh-SKU outcomes", raghav: "Written by Raghav" };

export default function LearningPage() {
  const [d, setD] = useState<Summary | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setD(await (await fetch("/api/learning", { cache: "no-store" })).json()), []);
  useEffect(() => { load(); }, [load]);

  async function act(body: unknown, ok: string) {
    setBusy(true);
    const res = await fetch("/api/learning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return toast(json.error, "err");
    toast(typeof ok === "string" ? ok : "Done");
    load();
    return json;
  }

  async function refresh() {
    const j = await act({ action: "refresh" }, "Checked for new outcomes.");
    if (j) toast(`Scored ${j.scored} decisions (${j.waiting} still waiting for newer data); ${j.drafted} new proposals.`);
  }

  if (!d) return <><div className="skel" style={{ height: 210, borderRadius: 18 }} /><div className="skel" style={{ height: 110 }} /></>;
  if (d.error) return <div className="banner red"><b>Could not load the learning loop.</b><p>{d.error}</p></div>;

  const pending = d.proposals.filter((p) => p.status === "proposed");
  const decidedProps = d.proposals.filter((p) => p.status !== "proposed");
  const maxTag = Math.max(1, ...d.overrideTags.map((t) => t.n));

  return (
    <>
      <PageHero photo={PHOTOS.sprouts} eyebrow="Learning · the closed loop" title="Every decision is checked against what happened"
        actions={<button className="btn primary" onClick={refresh} disabled={busy}>{busy ? <><span className="spinner" /> Checking…</> : "Check for new outcomes"}</button>}>
        <p>When newer sales and stock arrive, each decided line is scored. Patterns become lessons and rule changes. Nothing changes until Raghav accepts it.</p>
      </PageHero>

      <div className="loop" aria-label="Feedback loop stages">
        <div><i>1 · Decide</i><b><CountUp value={d.decided} /></b><span>lines decided by Raghav</span></div>
        <div><i>2 · Wait</i><b><CountUp value={d.awaitingOutcome} /></b><span>waiting for newer data</span></div>
        <div><i>3 · Score</i><b><CountUp value={d.scored} /></b><span>outcomes scored</span></div>
        <div><i>4 · Learn</i><b><CountUp value={pending.length} /></b><span>proposals for Raghav</span></div>
        <div><i>5 · Apply</i><b><CountUp value={d.proposals.filter((p) => p.status === "accepted").length} /></b><span>lessons and changes in use</span></div>
        <div><i>6 · Rules</i><b>v{d.rubricVersions[0]?.version ?? 1}</b><span>current rules version</span></div>
      </div>

      <div className="stats">
        <div className={`stat static ${d.accuracyPct === null ? "blue" : d.accuracyPct >= 80 ? "green" : d.accuracyPct >= 60 ? "amber" : "red"}`}>
          <b>{d.accuracyPct === null ? "—" : <><CountUp value={d.accuracyPct} />%</>}</b><span>Right calls</span><small>{d.scored ? `of ${d.scored} scored decisions` : "No outcomes yet: needs a newer sales week and stock snapshot."}</small>
        </div>
        <div className={`stat static ${d.demandBiasPct === null ? "blue" : Math.abs(d.demandBiasPct) <= 10 ? "green" : "amber"}`}>
          <b>{d.demandBiasPct === null ? "—" : `${d.demandBiasPct > 0 ? "+" : ""}${d.demandBiasPct}%`}</b><span>Forecast bias</span><small>{d.demandAbsErrPct === null ? "planned vs actual weekly demand" : `typical error ${d.demandAbsErrPct}% · negative = under-forecast`}</small>
        </div>
        <div className="stat static plum">
          <b>{(d.whoWasRight.raghav ?? 0)}<small style={{ fontSize: "1rem" }}> : {(d.whoWasRight.system ?? 0)}</small></b><span>Raghav : system</span><small>who was right when Raghav overrode</small>
        </div>
        <div className="stat static blue">
          <b>{d.useful.yes}<small style={{ fontSize: "1rem" }}> 👍 · {d.useful.no} 👎</small></b><span>Useful ratings</span><small>Raghav&apos;s one-tap feedback</small>
        </div>
      </div>

      <div className="card">
        <div className="row between"><h2>Proposals waiting for Raghav</h2><span className="chip c-plum">{pending.length}</span></div>
        {pending.length === 0 && <p className="muted small">None right now. Proposals appear when outcomes show a pattern, or when Raghav overrides the same SKU for the same reason twice.</p>}
        {pending.map((p) => (
          <div key={p.id} className={`proposal ${p.kind === "calibration" ? "cal" : "les"}`}>
            <div className="row between">
              <span className={`chip ${p.kind === "calibration" ? "c-blue" : "c-plum"}`}>{p.kind === "calibration" ? "Rule change" : "Lesson for Gemini"}</span>
              <span className="small muted">{SOURCE_LABEL[p.source] ?? p.source} · {fmtIST(p.created_at)}</span>
            </div>
            <p>{p.text}</p>
            {p.patch && <p className="mono small">{Object.entries(p.patch).map(([k, v]) => `${k} → ${v}`).join(" · ")}</p>}
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => act({ action: "accept", id: p.id }, p.kind === "calibration" ? "Rule change applied as a new rules version." : "Lesson accepted: Gemini will use it from the next run.")}>✓ Accept</button>
              <button className="btn" disabled={busy} onClick={() => act({ action: "dismiss", id: p.id }, "Dismissed.")}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Teach Gemini a lesson</h2>
          <p className="small muted">Write what you know that the data doesn&apos;t show. It is used on every run from now on.</p>
          <textarea id="lesson" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. NutriFlow runs a Diwali scheme every year in week 43: expect Mango Drink to jump 30%." />
          <div><button className="btn primary" disabled={busy || text.trim().length < 10} onClick={async () => { await act({ action: "add", text }, "Lesson added."); setText(""); }}>Add lesson</button></div>
        </div>
        <div className="card">
          <h2>Why Raghav overrides</h2>
          {d.overrideTags.length === 0 && <p className="small muted">No overrides yet.</p>}
          {d.overrideTags.map((t) => (
            <div key={t.tag} className="bar"><span>{t.label}</span><span className="track"><i style={{ width: `${(t.n / maxTag) * 100}%`, background: "var(--plum)" }} /></span><b>{t.n}</b></div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Recent outcomes</h2>
        {d.recent.length === 0 ? <p className="small muted">Nothing scored yet. After Raghav decides lines, upload the next week&apos;s sales and a new stock snapshot, then press “Check for new outcomes”.</p> : (
          <div className="tbl">
            <table>
              <thead><tr><th>Product</th><th>Run</th><th>Verdict</th><th className="n">Demand error</th><th>Who was right</th><th>What happened</th></tr></thead>
              <tbody>
                {d.recent.map((o) => {
                  const look = productLook(o.name, o.category);
                  return (
                    <tr key={o.recommendation_id}>
                      <td><div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="thumb" style={{ ["--cat" as string]: look.color }} src={photoUrl(look.photo, 80, 80)} alt="" loading="lazy" />
                        <span>{o.name.replace(/^Freshroots /, "")}</span></div></td>
                      <td className="mono">#{o.run_id}</td>
                      <td><span className={`chip ${VERDICT_TONE[o.verdict] ?? "c-grey"}`}>{d.verdicts.find((v) => v.verdict === o.verdict)?.label ?? o.verdict}</span></td>
                      <td className="n">{o.demand_error_pct === null ? "—" : `${o.demand_error_pct > 0 ? "+" : ""}${o.demand_error_pct}%`}</td>
                      <td>{o.who_was_right ?? "—"}</td>
                      <td className="small">{o.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Rules versions</h2>
          {d.rubricVersions.map((v) => <p key={v.version} className="small"><b className="mono">v{v.version}</b> · {fmtIST(v.created_at)} · {v.note}</p>)}
        </div>
        <div className="card">
          <h2>Decided proposals</h2>
          {decidedProps.length === 0 && <p className="small muted">None yet.</p>}
          {decidedProps.slice(0, 8).map((p) => <p key={p.id} className="small"><span className={`chip ${p.status === "accepted" ? "c-green" : "c-grey"}`}>{p.status}</span> {p.text}</p>)}
        </div>
      </div>
    </>
  );
}
