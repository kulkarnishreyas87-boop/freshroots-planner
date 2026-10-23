import { NextResponse } from "next/server";
import { all, exec, logAudit } from "@/lib/db";
import { findItemBySku, listVendors, ping, zohoMissing, type ZohoVendor } from "@/lib/zoho";
import { poStatusAfterCreate } from "@/lib/procure";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Connection state and the SKU / distributor mappings.
export async function GET() {
  const missing = zohoMissing();
  let connection: { ok: boolean; error?: string } = { ok: false, error: missing.length ? `Not set: ${missing.join(", ")} (.env.local locally, Environment Variables on Vercel)` : undefined };
  let vendors: ZohoVendor[] = [];
  if (!missing.length) {
    try {
      await ping();
      vendors = await listVendors();
      connection = { ok: true };
    } catch (err) {
      connection = { ok: false, error: (err as Error).message };
    }
  }
  try {
    const skus = await all(
      `SELECT s.sku_id, s.name, m.zoho_id, m.zoho_name, m.purchase_rate
         FROM skus s LEFT JOIN zoho_map m ON m.kind = 'item' AND m.local_id = s.sku_id ORDER BY s.sku_id`
    );
    const distributors = await all(
      `SELECT d.distributor_id, d.name, m.zoho_id, m.zoho_name
         FROM distributors d LEFT JOIN zoho_map m ON m.kind = 'vendor' AND m.local_id = d.distributor_id ORDER BY d.distributor_id`
    );
    return NextResponse.json({ connection, poStatus: poStatusAfterCreate(), skus, distributors, vendors });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// action "match-items": look up every unmapped SKU in Zoho by exact SKU.
// action "map": save one mapping { kind: "item" | "vendor", localId, zohoId, zohoName }.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.action === "match-items") {
    const skus = await all<{ sku_id: string }>(
      `SELECT s.sku_id FROM skus s LEFT JOIN zoho_map m ON m.kind = 'item' AND m.local_id = s.sku_id WHERE m.zoho_id IS NULL ORDER BY s.sku_id`
    );
    const results: { sku_id: string; found: boolean; error?: string }[] = [];
    for (const s of skus) {
      try {
        const item = await findItemBySku(s.sku_id);
        if (item) {
          await exec(
            `INSERT INTO zoho_map (kind, local_id, zoho_id, zoho_name, purchase_rate) VALUES ('item', $1, $2, $3, $4)
             ON CONFLICT (kind, local_id) DO UPDATE SET zoho_id = excluded.zoho_id, zoho_name = excluded.zoho_name, purchase_rate = excluded.purchase_rate, updated_at = now()`,
            [s.sku_id, item.item_id, item.name, item.purchase_rate]
          );
        }
        results.push({ sku_id: s.sku_id, found: !!item });
      } catch (err) {
        results.push({ sku_id: s.sku_id, found: false, error: (err as Error).message });
        break; // a sign-in or network error will fail every lookup the same way
      }
    }
    return NextResponse.json({ results });
  }

  if (body.action === "map") {
    const kind = body.kind;
    const localId = typeof body.localId === "string" ? body.localId : "";
    const zohoId = typeof body.zohoId === "string" ? body.zohoId.trim() : "";
    if ((kind !== "item" && kind !== "vendor") || !localId) return NextResponse.json({ error: "kind and localId are required" }, { status: 400 });
    if (!zohoId) {
      await exec(`DELETE FROM zoho_map WHERE kind = $1 AND local_id = $2`, [kind, localId]);
      return NextResponse.json({ ok: true, cleared: true });
    }
    if (!/^\d+$/.test(zohoId)) return NextResponse.json({ error: "A Zoho id is digits only." }, { status: 400 });
    await exec(
      `INSERT INTO zoho_map (kind, local_id, zoho_id, zoho_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, local_id) DO UPDATE SET zoho_id = excluded.zoho_id, zoho_name = excluded.zoho_name, updated_at = now()`,
      [kind, localId, zohoId, typeof body.zohoName === "string" ? body.zohoName : null]
    );
    await logAudit("zoho_map", { kind, localId, zohoId });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
