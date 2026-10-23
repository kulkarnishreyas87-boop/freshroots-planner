"use client";

import { useEffect, useState } from "react";

interface State { paused: boolean; reason: string | null; at: string | null }

export function KillSwitchBanner() {
  const [state, setState] = useState<State | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => fetch("/api/killswitch").then((r) => (r.ok ? r.json() : null)).then(setState).catch(() => undefined);
    load();
    window.addEventListener("killswitch-changed", load);
    return () => window.removeEventListener("killswitch-changed", load);
  }, []);

  if (!state?.paused) return null;

  async function resume() {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/killswitch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(json.error);
    setState(json);
    setNote("");
  }

  return (
    <div className="banner red" role="alert">
      <b>Kill switch is on. Scheduled runs are paused.</b>
      <p>{state.reason}</p>
      <p className="small">Since {state.at ? new Date(state.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unknown"}. Deepa: check the Status page before resuming.</p>
      <div className="row">
        <input id="resume-note" aria-label="What was recalibrated" placeholder="What was recalibrated?" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 260px" }} />
        <button className="btn" onClick={resume} disabled={busy}>Resume runs</button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
