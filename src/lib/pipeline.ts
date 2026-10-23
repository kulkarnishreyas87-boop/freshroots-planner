import { all, exec, one, tx, logAudit } from "./db";
import { decideBatch, geminiModel, type GeminiDecision } from "./gemini";
import { cleanAndCompute, DEFAULT_RUBRIC, qtyFor, type Rubric, type SkuMetrics } from "./rules";

// ---- Rubric -----------------------------------------------------------------

export async function getRubric(): Promise<Rubric> {
  const row = await one<{ rules: Rubric }>(`SELECT rules FROM rubric WHERE id = 1`);
  if (row) return { ...DEFAULT_RUBRIC, ...row.rules };
  await exec(`INSERT INTO rubric (id, rules) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(DEFAULT_RUBRIC)]);
  return DEFAULT_RUBRIC;
}

export async function saveRubric(r: Rubric): Promise<void> {
  await exec(
    `INSERT INTO rubric (id, rules, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET rules = excluded.rules, updated_at = now()`,
    [JSON.stringify(r)]
  );
  await logAudit("rubric_saved", r);
}

// ---- Kill switch ------------------------------------------------------------

export interface KillSwitchState {
  paused: boolean;
  reason: string | null;
  at: string | null;
}

export async function getKillSwitch(): Promise<KillSwitchState> {
  const row = await one<{ value: KillSwitchState }>(`SELECT value FROM settings WHERE key = 'kill_switch'`);
  return row?.value ?? { paused: false, reason: null, at: null };
}

async function setKillSwitch(s: KillSwitchState): Promise<void> {
  await exec(
    `INSERT INTO settings (key, value, updated_at) VALUES ('kill_switch', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [JSON.stringify(s)]
  );
  await logAudit(s.paused ? "kill_switch_tripped" : "kill_switch_resumed", s);
}

export interface RejectStats {
  windowDays: number;
  decided: number;
  rejected: number;
  rejectRatePct: number | null;
}

export async function rejectStats(rubric: Rubric): Promise<RejectStats> {
  const row = await one<{ decided: string; rejected: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('approved','rejected')) AS decided,
            count(*) FILTER (WHERE status = 'rejected') AS rejected
       FROM recommendations
      WHERE decided_at > now() - make_interval(days => $1)`,
    [rubric.kill_window_days]
  );
  const decided = Number(row?.decided ?? 0);
  const rejected = Number(row?.rejected ?? 0);
  return { windowDays: rubric.kill_window_days, decided, rejected, rejectRatePct: decided ? Math.round((rejected / decided) * 1000) / 10 : null };
}

/** Trips the kill switch when Raghav rejects too much, or a fresh SKU marked OK runs out. */
export async function evaluateKillSwitch(): Promise<KillSwitchState> {
  const current = await getKillSwitch();
  if (current.paused) return current;
  const rubric = await getRubric();

  const stats = await rejectStats(rubric);
  if (stats.decided >= rubric.kill_min_decisions && stats.rejectRatePct !== null && stats.rejectRatePct > rubric.kill_reject_rate_pct) {
    const s = {
      paused: true,
      reason: `Raghav rejected ${stats.rejected} of ${stats.decided} lines (${stats.rejectRatePct}%) in the last ${stats.windowDays} days, above the ${rubric.kill_reject_rate_pct}% limit. Recalibrate the rules before resuming.`,
      at: new Date().toISOString(),
    };
    await setKillSwitch(s);
    return s;
  }

  // A stockout reported on a High-perishability SKU whose latest decision before the report was OK.
  const miss = await one<{ sku_id: string; name: string; reported_at: string }>(
    `SELECT r.sku_id, s.name, r.reported_at
       FROM stockout_reports r
       JOIN skus s ON s.sku_id = r.sku_id AND s.perishability = 'High'
       JOIN LATERAL (
         SELECT rec.ai_flag, rec.rule_flag FROM recommendations rec JOIN runs ru ON ru.id = rec.run_id
          WHERE rec.sku_id = r.sku_id AND ru.started_at < r.reported_at AND ru.status = 'done'
          ORDER BY ru.started_at DESC LIMIT 1
       ) last ON coalesce(last.ai_flag, last.rule_flag) = 'OK'
      WHERE r.reported_at > now() - make_interval(days => $1)
      ORDER BY r.reported_at DESC LIMIT 1`,
    [rubric.kill_window_days]
  );
  if (miss) {
    const s = {
      paused: true,
      reason: `${miss.name} (${miss.sku_id}) ran out after the system marked it OK. Recalibrate the rules before resuming.`,
      at: new Date().toISOString(),
    };
    await setKillSwitch(s);
    return s;
  }
  return current;
}

export async function resumeKillSwitch(note: string): Promise<void> {
  await setKillSwitch({ paused: false, reason: null, at: new Date().toISOString() });
  await logAudit("kill_switch_resume_note", { note });
}

// ---- The run ----------------------------------------------------------------

const GEMINI_CHUNK = 40;

export interface RunResult {
  runId: number;
  status: "done" | "failed" | "skipped_paused";
  message: string;
}

export async function runPlanning(trigger: "cron" | "manual"): Promise<RunResult> {
  const ks = await evaluateKillSwitch();
  if (ks.paused) {
    const row = await one<{ id: number }>(
      `INSERT INTO runs (trigger, status, error, finished_at) VALUES ($1, 'skipped_paused', $2, now()) RETURNING id`,
      [trigger, ks.reason]
    );
    return { runId: row!.id, status: "skipped_paused", message: `Kill switch is on: ${ks.reason}` };
  }

  const model = geminiModel(); // fail before creating a run if the model is not configured
  const run = await one<{ id: number }>(`INSERT INTO runs (trigger, status, model) VALUES ($1, 'running', $2) RETURNING id`, [trigger, model]);
  const runId = run!.id;

  try {
    const rubric = await getRubric();
    const [skus, sales, inventory, openPos] = await Promise.all([
      all<{ sku_id: string; name: string; perishability: string; standard_reorder_qty: number; distributor_id: string | null }>(
        `SELECT sku_id, name, perishability, standard_reorder_qty, distributor_id FROM skus ORDER BY sku_id`
      ),
      all<{ sku_id: string; week: string; units_sold: number }>(`SELECT sku_id, week, units_sold FROM weekly_sales`),
      all<{ sku_id: string; units_on_hand: number; as_of_date: string }>(
        `SELECT sku_id, units_on_hand, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date FROM inventory`
      ),
      // Open POs = the last Zoho open-PO export, plus POs this app raised after that export
      // (otherwise Thursday's run would re-order what Monday's approval already ordered).
      all<{ sku_id: string; qty: number }>(
        `SELECT sku_id, qty FROM open_pos
         UNION ALL
         SELECT sku_id, final_qty FROM recommendations
          WHERE po_ref IS NOT NULL AND final_qty > 0
            AND po_placed_at > coalesce((SELECT (value->>'at')::timestamptz FROM settings WHERE key = 'open_pos_uploaded_at'), '-infinity')`
      ),
    ]);

    // The planning month is the month of the inventory snapshot (today's date if none loaded).
    const asOf = inventory.map((i) => i.as_of_date).sort().at(-1) ?? new Date().toISOString().slice(0, 10);
    const [y, m] = asOf.split("-").map(Number);
    const cal = await one<{ is_festival: boolean }>(`SELECT is_festival FROM calendar WHERE year = $1 AND month = $2`, [y, m]);

    const clean = cleanAndCompute({
      rubric,
      skus,
      sales,
      inventory,
      openPos,
      festivalFromCalendar: cal ? cal.is_festival : null,
      planningMonth: m,
    });

    const decisions = new Map<string, GeminiDecision>();
    const summaries: string[] = [];
    for (let i = 0; i < clean.metrics.length; i += GEMINI_CHUNK) {
      const chunk = clean.metrics.slice(i, i + GEMINI_CHUNK);
      const res = await decideBatch({ rubric, festival: clean.festival, latestWeek: clean.latestWeek, metrics: chunk });
      for (const d of res.decisions) if (chunk.some((c) => c.sku_id === d.sku_id)) decisions.set(d.sku_id, d);
      if (res.summary) summaries.push(res.summary);
    }

    await tx(async (c) => {
      // Older lines nobody decided on are replaced by this run's lines.
      await c.query(`UPDATE recommendations SET status = 'superseded' WHERE status = 'pending' AND run_id <> $1`, [runId]);
      for (const mtr of clean.metrics) {
        const row = mergeDecision(mtr, decisions.get(mtr.sku_id), rubric);
        await c.query(
          `INSERT INTO recommendations (run_id, sku_id, metrics, rule_flag, rule_action, ai_flag, ai_high_demand, ai_action, ai_reason,
             recommended_qty, is_exception, exception_reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            runId, mtr.sku_id, JSON.stringify(mtr), mtr.rule_flag, mtr.rule_action,
            row.ai_flag, row.ai_high_demand, row.ai_action, row.ai_reason,
            row.recommended_qty, row.exceptions.length > 0, JSON.stringify(row.exceptions),
          ]
        );
      }
      await c.query(
        `UPDATE runs SET status = 'done', finished_at = now(), as_of_date = $2, latest_week = $3, festival = $4, summary = $5, data_issues = $6
          WHERE id = $1`,
        [runId, asOf, clean.latestWeek, clean.festival, summaries.join(" "), JSON.stringify(clean.dataIssues)]
      );
    });

    return { runId, status: "done", message: `Planned ${clean.metrics.length} SKUs with sales up to ${clean.latestWeek}.` };
  } catch (err) {
    const msg = (err as Error).message;
    await exec(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, msg]);
    return { runId, status: "failed", message: msg };
  }
}

/** Gemini makes the decision; the rule result is the check. Any gap goes to Raghav. */
export function mergeDecision(m: SkuMetrics, d: GeminiDecision | undefined, rubric: Rubric) {
  const exceptions = [...m.exceptions];
  if (!d) {
    exceptions.push("Gemini returned no decision for this SKU. The rule result is shown instead.");
    return { ai_flag: null, ai_high_demand: null, ai_action: null, ai_reason: null, recommended_qty: m.rule_qty, exceptions };
  }
  if (d.flag !== m.rule_flag || d.action !== m.rule_action) {
    exceptions.push(`Gemini decided ${d.flag} / ${d.action}; the rules give ${m.rule_flag} / ${m.rule_action}.`);
  }
  // Gemini often repeats an exception the code already found; only add what is new.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.%]+/g, " ").trim();
  const said = d.raghav_reason.trim();
  if (d.needs_raghav && said && !exceptions.some((e) => norm(e).includes(norm(said)) || norm(said).includes(norm(e)))) {
    exceptions.push(`Gemini: ${said}`);
  } else if (d.needs_raghav && !said && exceptions.length === 0) {
    exceptions.push("Gemini asked for Raghav's judgment.");
  }
  return {
    ai_flag: d.flag,
    ai_high_demand: d.high_demand,
    ai_action: d.action,
    ai_reason: d.reason,
    recommended_qty: qtyFor(d.action, m.standard_reorder_qty, rubric),
    exceptions: [...new Set(exceptions)],
  };
}
