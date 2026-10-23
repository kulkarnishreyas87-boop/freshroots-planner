import { NextResponse } from "next/server";
import { exec, one, logAudit } from "@/lib/db";
import { evaluateKillSwitch } from "@/lib/pipeline";

// Records an actual stockout. If the SKU is fresh and was marked OK, the kill switch trips.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const skuId = typeof body.skuId === "string" ? body.skuId.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : null;
  const sku = await one(`SELECT sku_id FROM skus WHERE sku_id = $1`, [skuId]);
  if (!sku) return NextResponse.json({ error: "Unknown SKU" }, { status: 400 });
  await exec(`INSERT INTO stockout_reports (sku_id, note) VALUES ($1, $2)`, [skuId, note]);
  await logAudit("stockout_reported", { skuId, note });
  const killSwitch = await evaluateKillSwitch();
  return NextResponse.json({ ok: true, killSwitch });
}
