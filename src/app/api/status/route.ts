import { NextResponse } from "next/server";
import { all, one } from "@/lib/db";
import { getKillSwitch, getRubric, rejectStats } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

// Status dashboard: where every SKU stands, and the numbers Deepa watches.
export async function GET() {
  try {
    const rubric = await getRubric();
    const [killSwitch, rejects] = await Promise.all([getKillSwitch(), rejectStats(rubric)]);

    // Latest line per SKU from finished runs.
    const skus = await all(
      `SELECT DISTINCT ON (r.sku_id) r.id, r.sku_id, s.name, s.perishability, r.run_id, ru.latest_week,
              coalesce(r.ai_flag, r.rule_flag) AS flag, coalesce(r.ai_action, r.rule_action) AS action,
              r.recommended_qty, r.status, r.final_qty, r.decision_reason, r.po_ref, r.po_placed_at,
              (r.metrics->>'cover_weeks')::float AS cover_weeks
         FROM recommendations r JOIN runs ru ON ru.id = r.run_id AND ru.status = 'done' JOIN skus s ON s.sku_id = r.sku_id
        ORDER BY r.sku_id, ru.id DESC`
    );

    // Days from the end of the sales week a run used to the PO being recorded.
    const lag = await one<{ avg_days: string | null; pos: string }>(
      `SELECT round(avg(extract(epoch FROM (r.po_placed_at - (to_date(ru.latest_week, 'IYYY-"W"IW') + 7)::timestamp AT TIME ZONE 'Asia/Kolkata')) / 86400)::numeric, 1) AS avg_days,
              count(*) AS pos
         FROM recommendations r JOIN runs ru ON ru.id = r.run_id
        WHERE r.po_placed_at IS NOT NULL AND r.po_placed_at > now() - interval '90 days'`
    );

    const runs = await all(
      `SELECT id, trigger, status, latest_week, error, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 10`
    );
    const stockouts = await all(
      `SELECT r.id, r.sku_id, s.name, r.note, r.reported_at FROM stockout_reports r JOIN skus s ON s.sku_id = r.sku_id
        ORDER BY r.reported_at DESC LIMIT 20`
    );

    return NextResponse.json({
      killSwitch,
      rejects,
      killLimits: { pct: rubric.kill_reject_rate_pct, minDecisions: rubric.kill_min_decisions, days: rubric.kill_window_days },
      lag: { avgDays: lag?.avg_days === null || lag?.avg_days === undefined ? null : Number(lag.avg_days), pos: Number(lag?.pos ?? 0) },
      skus,
      runs,
      stockouts,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
