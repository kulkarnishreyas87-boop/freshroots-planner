import { createHash } from "node:crypto";
import { all, exec, one, tx, logAudit } from "./db";
import { decideBatch, geminiModel, PROMPT_VERSION, type GeminiDecision } from "./gemini";
import { acceptedLessons, draftProposals, scoreOutcomes } from "./learning";
import { cleanAndCompute, compareWeeks, dataGate, DEFAULT_RUBRIC, qtyFor, type Rubric, type SkuMetrics } from "./rules";

// ---- Rubric (versioned) ---------------------------------------------------------

export async function getRubric(): Promise<Rubric> {
  const row = await one<{ rules: Rubric }>(`SELECT rules FROM rubric WHERE id = 1`);
  if (row) return { ...DEFAULT_RUBRIC, ...row.rules };
  await saveRubric(DEFAULT_RUBRIC, "Default rules from Raghav's documented logic");
  return DEFAULT_RUBRIC;
}

export async function rubricVersion(): Promise<number> {
  const row = await one<{ v: number | null }>(`SELECT max(version) AS v FROM rubric_history`);
  if (row?.v) return row.v;
  // Rules saved before versioning existed: record them as version 1.
  const current = await one<{ rules: Rubric }>(`SELECT rules FROM rubric WHERE id = 1`);
  if (!current) return 0;
  const ins = await one<{ version: number }>(
    `INSERT INTO rubric_history (rules, note) VALUES ($1, 'Rules in use when versioning started') RETURNING version`,
    [JSON.stringify({ ...DEFAULT_RUBRIC, ...current.rules })]
  );
  return ins!.version;
}

/** Saves the rubric and keeps every earlier version. Returns the new version number. */
export async function saveRubric(r: Rubric, note = "Edited on the Rules page"): Promise<number> {
  const v = await tx(async (c) => {
    await c.query(
      `INSERT INTO rubric (id, rules, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET rules = excluded.rules, updated_at = now()`,
      [JSON.stringify(r)]
    );
    const res = await c.query<{ version: number }>(`INSERT INTO rubric_history (rules, note) VALUES ($1, $2) RETURNING version`, [JSON.stringify(r), note]);
    return res.rows[0].version;
  });
  await logAudit("rubric_saved", { version: v, note });
  return v;
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

  // Outcome scoring found a fresh SKU the system missed (it ran short and wasn't flagged).
  const scoredMiss = await one<{ sku_id: string; name: string; detail: string }>(
    `SELECT r.sku_id, s.name, o.detail FROM outcomes o
       JOIN recommendations r ON r.id = o.recommendation_id JOIN skus s ON s.sku_id = r.sku_id
      WHERE s.perishability = 'High' AND o.verdict = 'missed_stockout' AND coalesce(r.ai_flag, r.rule_flag) <> 'STOCKOUT_RISK'
        AND o.scored_at > now() - make_interval(days => $1)
        AND o.scored_at > coalesce((SELECT (value->>'at')::timestamptz FROM settings WHERE key = 'kill_switch' AND value->>'paused' = 'false'), '-infinity')
      ORDER BY o.scored_at DESC LIMIT 1`,
    [rubric.kill_window_days]
  );
  if (scoredMiss) {
    const s = {
      paused: true,
      reason: `Outcome check: ${scoredMiss.name} (${scoredMiss.sku_id}) ran short without being flagged. ${scoredMiss.detail} Recalibrate before resuming.`,
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
const STALE_RUN_MINUTES = 15;

export type RunStatus = "done" | "failed" | "skipped_paused" | "skipped_busy" | "skipped_same_data" | "blocked_data";

export interface RunResult {
  runId: number | null;
  status: RunStatus;
  message: string;
}

/**
 * One planning run, in loop order:
 *   learn (score past decisions, draft proposals) → kill switch → claim the run slot →
 *   data gate → same-data check → rules in code → Gemini → rule check → save, with full trace.
 */
export async function runPlanning(trigger: "cron" | "manual"): Promise<RunResult> {
  const t0 = Date.now();

  // 1. Learn from what happened since the last run. Learning never blocks planning.
  let learned = { scored: 0, drafted: 0 };
  try {
    const s = await scoreOutcomes();
    learned = { scored: s.scored, drafted: await draftProposals(await getRubric()) };
  } catch (err) {
    console.error("[learn] skipped:", (err as Error).message);
  }

  // 2. Kill switch.
  const ks = await evaluateKillSwitch();
  if (ks.paused) {
    const row = await one<{ id: number }>(
      `INSERT INTO runs (trigger, status, error, finished_at) VALUES ($1, 'skipped_paused', $2, now()) RETURNING id`,
      [trigger, ks.reason]
    );
    return { runId: row!.id, status: "skipped_paused", message: `Kill switch is on: ${ks.reason}` };
  }

  // 3. Claim the single 'running' slot (unique index). Release a crashed run first.
  const model = geminiModel();
  await exec(
    `UPDATE runs SET status = 'failed', error = 'Run did not finish (timed out or crashed).', finished_at = now()
      WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
    [STALE_RUN_MINUTES]
  );
  let runId: number;
  try {
    const run = await one<{ id: number }>(
      `INSERT INTO runs (trigger, status, model, prompt_version) VALUES ($1, 'running', $2, $3) RETURNING id`,
      [trigger, model, PROMPT_VERSION]
    );
    runId = run!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { runId: null, status: "skipped_busy", message: "Another run is already in progress, so this one was skipped." };
    throw err;
  }

  const finish = async (status: RunStatus, fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    await exec(
      `UPDATE runs SET status = $2, finished_at = now(), duration_ms = $3${cols.map((c, i) => `, ${c} = $${i + 4}`).join("")} WHERE id = $1`,
      [runId, status, Date.now() - t0, ...cols.map((c) => fields[c])]
    );
  };

  try {
    const [rubric, rv, lessons] = await Promise.all([getRubric(), rubricVersion(), acceptedLessons()]);
    const [skus, sales, inventory, openPos] = await Promise.all([
      all<{ sku_id: string; name: string; perishability: string; standard_reorder_qty: number; distributor_id: string | null }>(
        `SELECT sku_id, name, perishability, standard_reorder_qty, distributor_id FROM skus ORDER BY sku_id`
      ),
      all<{ sku_id: string; week: string; units_sold: number }>(`SELECT sku_id, week, units_sold FROM weekly_sales ORDER BY sku_id, week`),
      all<{ sku_id: string; units_on_hand: number; as_of_date: string }>(
        `SELECT sku_id, units_on_hand, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date FROM inventory ORDER BY sku_id, location`
      ),
      // Open POs = the last Zoho open-PO export, plus POs this app raised after that export
      // (otherwise Thursday's run would re-order what Monday's approval already ordered).
      all<{ sku_id: string; qty: number }>(
        `SELECT sku_id, qty FROM open_pos
         UNION ALL
         SELECT sku_id, final_qty FROM recommendations
          WHERE po_ref IS NOT NULL AND final_qty > 0
            AND po_placed_at > coalesce((SELECT (value->>'at')::timestamptz FROM settings WHERE key = 'open_pos_uploaded_at'), '-infinity')
         ORDER BY 1, 2`
      ),
    ]);

    // 4. Data gate: stale or incomplete data never reaches Gemini.
    const latestWeek = sales.length ? sales.map((s) => s.week).sort(compareWeeks).at(-1)! : null;
    const gate = dataGate({ rubric, today: new Date(), skus, latestWeek, inventory });
    if (!gate.ok) {
      await finish("blocked_data", { error: gate.blockers.join(" "), gate: JSON.stringify(gate), rubric_version: rv });
      return { runId, status: "blocked_data", message: `The data gate stopped the run: ${gate.blockers.join(" ")}` };
    }

    // 5. A scheduled run on exactly the same inputs has nothing new to decide.
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ skus, sales, inventory, openPos, rubric, lessons, PROMPT_VERSION, model }))
      .digest("hex")
      .slice(0, 16);
    if (trigger === "cron") {
      const last = await one<{ input_hash: string | null }>(`SELECT input_hash FROM runs WHERE status = 'done' ORDER BY id DESC LIMIT 1`);
      if (last?.input_hash === inputHash) {
        await finish("skipped_same_data", { input_hash: inputHash, gate: JSON.stringify(gate), rubric_version: rv });
        return { runId, status: "skipped_same_data", message: "No new sales, stock or rule changes since the last run, so nothing new to decide." };
      }
    }

    // 6. Rules in code.
    const [y, m] = (inventory.map((i) => i.as_of_date).sort().at(-1) as string).split("-").map(Number);
    const asOf = inventory.map((i) => i.as_of_date).sort().at(-1)!;
    const cal = await one<{ is_festival: boolean }>(`SELECT is_festival FROM calendar WHERE year = $1 AND month = $2`, [y, m]);
    const clean = cleanAndCompute({ rubric, skus, sales, inventory, openPos, festivalFromCalendar: cal ? cal.is_festival : null, planningMonth: m });

    // 7. Gemini decides every SKU with complete data. SKUs with no stock row go to Raghav undecided.
    const missing = new Set(gate.missingInventory);
    const decidable = clean.metrics.filter((x) => !missing.has(x.sku_id));
    const decisions = new Map<string, GeminiDecision>();
    const summaries: string[] = [];
    const problems: string[] = [];
    let tokensIn = 0, tokensOut = 0;
    for (let i = 0; i < decidable.length; i += GEMINI_CHUNK) {
      const chunk = decidable.slice(i, i + GEMINI_CHUNK);
      const res = await decideBatch({ rubric, festival: clean.festival, latestWeek: clean.latestWeek, metrics: chunk, lessons });
      for (const d of res.decisions) decisions.set(d.sku_id, d);
      if (res.summary) summaries.push(res.summary);
      problems.push(...res.problems);
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
    }

    // 8. Save atomically: the old queue is only replaced once the new one is complete.
    await tx(async (c) => {
      await c.query(`UPDATE recommendations SET status = 'superseded' WHERE status = 'pending' AND run_id <> $1`, [runId]);
      for (const mtr of clean.metrics) {
        const row = missing.has(mtr.sku_id)
          ? { ai_flag: null, ai_high_demand: null, ai_action: null, ai_reason: null, recommended_qty: 0,
              exceptions: [...mtr.exceptions, "Gemini was not asked: fix the stock data for this SKU, then run again."] }
          : mergeDecision(mtr, decisions.get(mtr.sku_id), rubric);
        await c.query(
          `INSERT INTO recommendations (run_id, sku_id, metrics, rule_flag, rule_action, ai_flag, ai_high_demand, ai_action, ai_reason,
             recommended_qty, is_exception, exception_reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [runId, mtr.sku_id, JSON.stringify(mtr), mtr.rule_flag, mtr.rule_action, row.ai_flag, row.ai_high_demand, row.ai_action,
            row.ai_reason, row.recommended_qty, row.exceptions.length > 0, JSON.stringify(row.exceptions)]
        );
      }
      await c.query(
        `UPDATE runs SET status = 'done', finished_at = now(), as_of_date = $2, latest_week = $3, festival = $4, summary = $5, data_issues = $6,
                rubric_version = $7, input_hash = $8, tokens_in = $9, tokens_out = $10, duration_ms = $11, gate = $12
          WHERE id = $1`,
        [runId, asOf, clean.latestWeek, clean.festival, summaries.join(" "), JSON.stringify([...clean.dataIssues, ...gate.warnings, ...problems]),
          rv, inputHash, tokensIn, tokensOut, Date.now() - t0, JSON.stringify(gate)]
      );
    });

    const learnNote = learned.scored || learned.drafted ? ` Scored ${learned.scored} past decisions; ${learned.drafted} new proposals for Raghav.` : "";
    return { runId, status: "done", message: `Planned ${clean.metrics.length} SKUs with sales up to ${clean.latestWeek}.${learnNote}` };
  } catch (err) {
    const msg = (err as Error).message;
    await finish("failed", { error: msg });
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
