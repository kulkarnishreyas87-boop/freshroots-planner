import { NextResponse } from "next/server";
import { all, logAudit } from "@/lib/db";
import { evaluateKillSwitch } from "@/lib/pipeline";
import { raisePos } from "@/lib/procure";

export const maxDuration = 120;

// Approves the routine lines of a run in one go. Exceptions and High-perishability
// lines are never included: Raghav decides those one by one.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const runId = Number(body.runId);
  if (!Number.isInteger(runId)) return NextResponse.json({ error: "runId is required" }, { status: 400 });

  const rows = await all<{ id: number; final_qty: number }>(
    `UPDATE recommendations r SET status = 'approved', final_qty = r.recommended_qty, decided_at = now(), decision_reason = 'Bulk-approved routine line'
       FROM skus s
      WHERE s.sku_id = r.sku_id AND r.run_id = $1 AND r.status = 'pending' AND NOT r.is_exception AND s.perishability <> 'High'
      RETURNING r.id, r.final_qty`,
    [runId]
  );
  await logAudit("bulk_approve", { runId, ids: rows.map((r) => r.id) });
  const killSwitch = await evaluateKillSwitch();
  const pos = await raisePos(rows.filter((r) => r.final_qty > 0).map((r) => r.id));
  return NextResponse.json({ approved: rows.length, killSwitch, pos });
}
