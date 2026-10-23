import { NextResponse } from "next/server";
import { all, one } from "@/lib/db";
import { getKillSwitch } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

// The latest finished run and its lines, exceptions first, then stockout, overstock, OK.
export async function GET() {
  try {
    const run = await one(
      `SELECT id, trigger, status, to_char(as_of_date,'YYYY-MM-DD') AS as_of_date, latest_week, festival, model, summary, data_issues, started_at, finished_at
         FROM runs WHERE status = 'done' ORDER BY id DESC LIMIT 1`
    );
    const lastAttempt = await one(`SELECT id, trigger, status, error, started_at FROM runs ORDER BY id DESC LIMIT 1`);
    const killSwitch = await getKillSwitch();
    if (!run) return NextResponse.json({ run: null, lastAttempt, killSwitch, lines: [] });

    const lines = await all(
      `SELECT r.id, r.sku_id, s.name, s.perishability, s.distributor_id, r.metrics, r.rule_flag, r.rule_action,
              r.ai_flag, r.ai_high_demand, r.ai_action, r.ai_reason, r.recommended_qty, r.is_exception, r.exception_reasons,
              r.status, r.final_qty, r.decision_reason, r.decided_at, r.po_ref, r.po_placed_at,
              r.zoho_status, r.zoho_error, r.zoho_reference
         FROM recommendations r JOIN skus s ON s.sku_id = r.sku_id
        WHERE r.run_id = $1
        ORDER BY r.is_exception DESC,
                 CASE coalesce(r.ai_flag, r.rule_flag) WHEN 'STOCKOUT_RISK' THEN 0 WHEN 'OVERSTOCK_RISK' THEN 1 ELSE 2 END,
                 (r.metrics->>'cover_weeks')::float NULLS FIRST, r.sku_id`,
      [run.id]
    );
    return NextResponse.json({ run, lastAttempt, killSwitch, lines });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
