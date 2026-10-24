import { NextResponse } from "next/server";
import { exec, one, logAudit } from "@/lib/db";
import { evaluateKillSwitch } from "@/lib/pipeline";
import { raisePo } from "@/lib/procure";
import { REASON_TAGS } from "@/lib/learning";

export const maxDuration = 60;

// Raghav's Approve / Reject. Changing the quantity or rejecting needs a reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const decision = body.decision;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const tag = typeof body.reasonTag === "string" && body.reasonTag in REASON_TAGS ? body.reasonTag : null;

  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });
  }
  const line = await one<{ id: number; status: string; recommended_qty: number }>(
    `SELECT id, status, recommended_qty FROM recommendations WHERE id = $1`,
    [Number(id)]
  );
  if (!line) return NextResponse.json({ error: "Line not found" }, { status: 404 });
  if (line.status !== "pending") return NextResponse.json({ error: `This line is already ${line.status}.` }, { status: 409 });

  let finalQty: number | null = null;
  if (decision === "approve") {
    finalQty = body.qty === undefined || body.qty === null || body.qty === "" ? line.recommended_qty : Number(body.qty);
    if (!Number.isInteger(finalQty) || finalQty < 0) return NextResponse.json({ error: "Quantity must be a whole number, zero or more." }, { status: 400 });
    if (finalQty !== line.recommended_qty && !reason) {
      return NextResponse.json({ error: "Give a reason when you change the quantity." }, { status: 400 });
    }
  } else if (!reason) {
    return NextResponse.json({ error: "Give a reason when you reject a line." }, { status: 400 });
  }

  await exec(
    `UPDATE recommendations SET status = $2, final_qty = $3, decision_reason = $4, reason_tag = $5, decided_at = now() WHERE id = $1`,
    [line.id, decision === "approve" ? "approved" : "rejected", finalQty, reason || null, reason ? tag ?? "other" : null]
  );
  await logAudit("decision", { id: line.id, decision, finalQty, reason, tag });
  const killSwitch = await evaluateKillSwitch();
  // An approved order goes straight to Zoho as a purchase order.
  const po = decision === "approve" && finalQty ? await raisePo(line.id) : null;
  return NextResponse.json({ ok: true, killSwitch, po });
}
