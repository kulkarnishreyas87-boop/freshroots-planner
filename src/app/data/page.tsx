"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHero } from "@/components/PageHero";
import { toast } from "@/components/Toasts";
import { PHOTOS } from "@/lib/photos";

interface Ds { name: string; columns: string[]; rows: number; latest: string | null }

const SOURCE: Record<string, string> = {
  sku_master: "SAP",
  distributor_master: "SAP",
  calendar: "SAP",
  weekly_sales: "SAP",
  current_inventory: "SAP",
  open_pos: "Zoho",
};

export default function DataPage() {
  const [sets, setSets] = useState<Ds[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const json = await (await fetch("/api/upload", { cache: "no-store" })).json();
    if (json.error) setError(json.error);
    else setSets(json.datasets);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHero photo={PHOTOS.boxes} eyebrow="Input · Data from SAP and Zoho" title="Load the exports">
        <p>Upload each CSV export before a run. Files must have exactly the columns shown. Sales and inventory are added or updated row by row; open POs replace the old list.</p>
      </PageHero>
      {error && <div className="banner red"><b>Could not read the database.</b><p>{error}</p></div>}
      {sets && <div className="grid2">{sets.map((s) => <UploadCard key={s.name} ds={s} onDone={load} />)}</div>}
    </>
  );
}

function UploadCard({ ds, onDone }: { ds: Ds; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(ds.name === "open_pos");
  const [result, setResult] = useState<{ ok: boolean; text: string; skipped?: { line: number; reason: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("dataset", ds.name);
    fd.set("file", file);
    fd.set("replace", String(replace));
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const json = await res.json();
    setBusy(false);
    setResult(res.ok ? { ok: true, text: `${json.loaded} rows loaded.`, skipped: json.skipped } : { ok: false, text: json.error });
    toast(res.ok ? `${ds.name}: ${json.loaded} rows loaded${json.skipped?.length ? `, ${json.skipped.length} skipped` : ""}.` : json.error, res.ok ? (json.skipped?.length ? "warn" : "ok") : "err");
    onDone();
  }

  return (
    <div className="card">
      <div className="row between">
        <h2 className="mono" style={{ fontSize: "0.95rem" }}>{ds.name}.csv</h2>
        <span className="chip c-grey">{SOURCE[ds.name]}</span>
      </div>
      <p className="small">{ds.rows} rows loaded{ds.latest ? ` · latest ${ds.latest}` : ""}</p>
      <p className="small mono muted" style={{ wordBreak: "break-word" }}>{ds.columns.join(",")}</p>
      <input id={`file-${ds.name}`} aria-label={`${ds.name} CSV file`} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
        <input id={`replace-${ds.name}`} type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        Replace everything in this table
      </label>
      <div><button className="btn primary" onClick={upload} disabled={!file || busy}>{busy ? "Uploading…" : "Upload"}</button></div>
      {result && <p className={result.ok ? "small" : "error"}>{result.text}</p>}
      {result?.skipped && result.skipped.length > 0 && (
        <ul className="exc-list">{result.skipped.slice(0, 10).map((s) => <li key={s.line}>Line {s.line}: {s.reason}</li>)}</ul>
      )}
    </div>
  );
}
