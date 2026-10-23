import { NextResponse } from "next/server";
import { exec, one, logAudit } from "@/lib/db";

// Manual fallback: procurement records a PO they raised in Zoho by hand
// (Zoho not connected, or the automatic PO failed and they raised it themselves).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const poRef = typeof body.poRef === "string" ? body.poRef.trim() : "";
  if (!poRef) return NextResponse.json({ error: "Enter the Zoho PO number." }, { status: 400 });

  const line = await one<{ id: number; status: string; final_qty: number | null; po_ref: string | null; zoho_status: string | null }>(
    `SELECT id, status, final_qty, po_ref, zoho_status FROM recommendations WHERE id = $1`,
    [Number(id)]
  );
  if (!line) return NextResponse.json({ error: "Line not found" }, { status: 404 });
  if (line.zoho_status === "creating") return NextResponse.json({ error: "The app is raising this PO in Zoho right now." }, { status: 409 });
  if (line.status !== "approved" || !line.final_qty) {
    return NextResponse.json({ error: "Only approved lines with a quantity can get a PO." }, { status: 409 });
  }
  if (line.po_ref) return NextResponse.json({ error: `PO ${line.po_ref} is already recorded.` }, { status: 409 });

  await exec(`UPDATE recommendations SET po_ref = $2, po_placed_at = now() WHERE id = $1`, [line.id, poRef]);
  await logAudit("po_recorded", { id: line.id, poRef });
  return NextResponse.json({ ok: true });
}
