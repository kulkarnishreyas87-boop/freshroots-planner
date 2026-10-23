"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHero } from "@/components/PageHero";
import { PHOTOS } from "@/lib/photos";

interface ZohoData {
  connection: { ok: boolean; error?: string };
  poStatus: "draft" | "issued";
  skus: { sku_id: string; name: string; zoho_id: string | null; zoho_name: string | null; purchase_rate: number | null }[];
  distributors: { distributor_id: string; name: string; zoho_id: string | null; zoho_name: string | null }[];
  vendors: { contact_id: string; contact_name: string; company_name: string }[];
  error?: string;
}

export default function ZohoPage() {
  const [d, setD] = useState<ZohoData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setD(await (await fetch("/api/zoho", { cache: "no-store" })).json()), []);
  useEffect(() => { load(); }, [load]);

  async function post(body: unknown) {
    setBusy(true);
    const res = await fetch("/api/zoho", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(false);
    await load();
    return { ok: res.ok, json };
  }

  async function matchItems() {
    const { ok, json } = await post({ action: "match-items" });
    if (!ok) return setMsg({ ok: false, text: json.error });
    const r = json.results as { sku_id: string; found: boolean; error?: string }[];
    const err = r.find((x) => x.error);
    setMsg(err ? { ok: false, text: err.error! } : { ok: true, text: `Matched ${r.filter((x) => x.found).length} of ${r.length} unmatched SKUs. Unmatched: ${r.filter((x) => !x.found).map((x) => x.sku_id).join(", ") || "none"}.` });
  }

  async function map(kind: "item" | "vendor", localId: string, zohoId: string, zohoName: string | null) {
    const { ok, json } = await post({ action: "map", kind, localId, zohoId, zohoName });
    setMsg(ok ? { ok: true, text: zohoId ? `Saved ${localId}.` : `Cleared ${localId}.` } : { ok: false, text: json.error });
  }

  if (!d) return <p className="muted">Loading…</p>;
  if (d.error) return <div className="banner red"><b>Could not load.</b><p>{d.error}</p></div>;

  const unmappedItems = d.skus.filter((s) => !s.zoho_id).length;
  const unmappedVendors = d.distributors.filter((s) => !s.zoho_id).length;

  return (
    <>
      <PageHero photo={PHOTOS.truck} eyebrow="Output · PO in Zoho Inventory" title="Zoho connection">
        <p>When Raghav approves an order, the app raises the purchase order in Zoho straight away. Each SKU needs its Zoho item, and each distributor its Zoho vendor.</p>
      </PageHero>

      <div className={`banner ${d.connection.ok ? "green" : "red"}`}>
        <b>{d.connection.ok ? "Connected to Zoho Inventory." : "Not connected to Zoho."}</b>
        {d.connection.error && <p>{d.connection.error}</p>}
        <p className="small">New POs are created as <b>{d.poStatus}</b>{d.poStatus === "draft" ? " (set ZOHO_PO_STATUS=issued in .env.local to issue them straight away)" : ""}.</p>
      </div>

      {msg && <div className={`banner ${msg.ok ? "green" : "red"}`}><p>{msg.text}</p></div>}

      <div className="card">
        <div className="row between">
          <h2>SKUs → Zoho items</h2>
          <button className="btn primary" onClick={matchItems} disabled={busy || !d.connection.ok || unmappedItems === 0}>Match {unmappedItems} by SKU</button>
        </div>
        <p className="small muted">Matching looks for a Zoho item whose SKU is exactly the Freshroots SKU id. If your Zoho SKUs differ, paste the Zoho item id by hand.</p>
        <div className="tbl">
          <table>
            <thead><tr><th>SKU</th><th>Product</th><th>Zoho item</th><th className="n">Zoho purchase rate</th><th>Item id</th></tr></thead>
            <tbody>
              {d.skus.map((s) => (
                <tr key={s.sku_id}>
                  <td className="mono">{s.sku_id}</td>
                  <td>{s.name}</td>
                  <td>{s.zoho_id ? s.zoho_name ?? "(set by hand)" : <span className="chip c-amber">not mapped</span>}</td>
                  <td className="n">{s.purchase_rate ?? "—"}</td>
                  <td><IdInput id={`item-${s.sku_id}`} value={s.zoho_id ?? ""} onSave={(v) => map("item", s.sku_id, v, null)} disabled={busy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Distributors → Zoho vendors</h2>
        <p className="small muted">The PO goes to the vendor you choose here for the SKU&apos;s distributor (Distributor_ID in the SKU master). {unmappedVendors} not mapped.</p>
        <div className="tbl">
          <table>
            <thead><tr><th>Distributor</th><th>Name</th><th>Zoho vendor</th></tr></thead>
            <tbody>
              {d.distributors.map((x) => (
                <tr key={x.distributor_id}>
                  <td className="mono">{x.distributor_id}</td>
                  <td>{x.name}</td>
                  <td>
                    {d.vendors.length ? (
                      <select id={`vendor-${x.distributor_id}`} aria-label={`Zoho vendor for ${x.name}`} value={x.zoho_id ?? ""} disabled={busy}
                        onChange={(e) => {
                          const v = d.vendors.find((vv) => vv.contact_id === e.target.value);
                          map("vendor", x.distributor_id, e.target.value, v ? v.contact_name : null);
                        }}>
                        <option value="">Not mapped</option>
                        {x.zoho_id && !d.vendors.some((v) => v.contact_id === x.zoho_id) && <option value={x.zoho_id}>{x.zoho_name ?? x.zoho_id}</option>}
                        {d.vendors.map((v) => <option key={v.contact_id} value={v.contact_id}>{v.contact_name}{v.company_name && v.company_name !== v.contact_name ? ` (${v.company_name})` : ""}</option>)}
                      </select>
                    ) : (
                      <span className="small muted">{x.zoho_id ? `${x.zoho_name ?? ""} ${x.zoho_id}` : "Connect Zoho to choose a vendor"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function IdInput({ id, value, onSave, disabled }: { id: string; value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input id={id} aria-label="Zoho item id" className="mono" style={{ width: 170 }} value={v} onChange={(e) => setV(e.target.value)} placeholder="Zoho item id" />
      <button className="btn" disabled={disabled || v === value} onClick={() => onSave(v.trim())}>Save</button>
    </div>
  );
}
