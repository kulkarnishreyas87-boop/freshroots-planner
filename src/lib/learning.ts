import { all, exec, logAudit, one } from "./db";
import { compareWeeks, validateRubric, type Rubric } from "./rules";

/**
 * The feedback half of the loop:
 *   1. score every decided line against the sales and stock that came after it;
 *   2. draft lessons (from Raghav's repeated overrides and from misses) and
 *      calibration proposals (rubric changes backed by outcome evidence);
 *   3. only what Raghav accepts reaches the next run.
 */

export type StockState = "stocked_out" | "under_window" | "in_window" | "over_window";
export type Verdict = "right" | "missed_stockout" | "short_after_order" | "false_alarm" | "missed_overstock" | "unnecessary_order";

export const VERDICT_LABEL: Record<Verdict, string> = {
  right: "Right call",
  missed_stockout: "Missed a stockout",
  short_after_order: "Still short after the order",
  false_alarm: "False alarm",
  missed_overstock: "Missed an overstock",
  unnecessary_order: "Ordered when not needed",
};

export interface ScoreInput {
  flag: string; // the flag the line was decided on (Gemini's, else the rule's)
  status: "approved" | "rejected";
  finalQty: number | null;
  recommendedQty: number;
  minWeeks: number;
  maxWeeks: number;
  forecastWeeklyDemand: number | null;
  salesAfter: number[]; // weekly units in the weeks after the run's sales week
  next: { asOf: string; onHand: number } | null; // first stock snapshot after the run
  stockoutReported: boolean;
}

export interface Score {
  weeksObserved: number;
  actualWeeklyDemand: number;
  demandErrorPct: number | null; // (forecast - actual) / actual: negative = under-forecast
  nextCover: number | null;
  stockState: StockState;
  verdict: Verdict;
  whoWasRight: "system" | "raghav" | null; // only when Raghav overrode the line
  detail: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: returns null when there isn't yet enough later data to judge. */
export function scoreOutcome(s: ScoreInput): Score | null {
  if (s.salesAfter.length === 0 || !s.next) return null;
  const actual = s.salesAfter.reduce((a, b) => a + b, 0) / s.salesAfter.length;
  const err = s.forecastWeeklyDemand && actual > 0 ? ((s.forecastWeeklyDemand - actual) / actual) * 100 : null;
  const rate = actual > 0 ? actual : s.forecastWeeklyDemand ?? 0;
  const cover = rate > 0 ? s.next.onHand / rate : null;

  let state: StockState;
  if (s.stockoutReported || s.next.onHand === 0) state = "stocked_out";
  else if (cover !== null && cover < s.minWeeks) state = "under_window";
  else if (cover !== null && cover > s.maxWeeks) state = "over_window";
  else state = "in_window";

  const ordered = s.status === "approved" && (s.finalQty ?? 0) > 0;
  const short = state === "stocked_out" || state === "under_window";
  let verdict: Verdict;
  if (short) verdict = s.flag === "STOCKOUT_RISK" && ordered ? "short_after_order" : "missed_stockout";
  else if (state === "over_window") verdict = ordered ? "unnecessary_order" : s.flag === "OVERSTOCK_RISK" ? "right" : s.flag === "STOCKOUT_RISK" ? "false_alarm" : "missed_overstock";
  else verdict = "right";

  // Who was right, when Raghav rejected the system's line.
  let who: Score["whoWasRight"] = null;
  if (s.status === "rejected" && s.flag !== "OK") {
    const systemFeared = s.flag === "STOCKOUT_RISK" ? short : state === "over_window";
    who = systemFeared ? "system" : "raghav";
  }

  const detail =
    `Actual ${r1(actual)}/wk over ${s.salesAfter.length} wk vs ${s.forecastWeeklyDemand ?? "?"} planned` +
    `${err === null ? "" : ` (${err >= 0 ? "+" : ""}${r1(err)}%)`}; on ${s.next.asOf} stock was ${s.next.onHand}` +
    `${cover === null ? "" : ` = ${r1(cover)} wk`} against ${s.minWeeks}–${s.maxWeeks}.`;

  return { weeksObserved: s.salesAfter.length, actualWeeklyDemand: r1(actual), demandErrorPct: err === null ? null : r1(err), nextCover: cover === null ? null : r1(cover), stockState: state, verdict, whoWasRight: who, detail };
}

// ---- Scoring against the database --------------------------------------------

// Two runs on the same sales week decide the same SKU twice; only the latest decision
// is scored, so one week of later data is never counted twice.
const LATEST_DECISION_ONLY = `AND NOT EXISTS (
  SELECT 1 FROM recommendations r2 JOIN runs ru2 ON ru2.id = r2.run_id
   WHERE r2.sku_id = r.sku_id AND ru2.latest_week = ru.latest_week AND r2.run_id > r.run_id AND r2.status IN ('approved','rejected'))`;

interface Unscored {
  id: number;
  sku_id: string;
  status: "approved" | "rejected";
  final_qty: number | null;
  recommended_qty: number;
  flag: string;
  latest_week: string;
  as_of_date: string;
  started_at: string;
  min_weeks: number;
  max_weeks: number;
  weekly_demand: number | null;
}

export async function scoreOutcomes(): Promise<{ scored: number; waiting: number }> {
  const lines = await all<Unscored>(
    `SELECT r.id, r.sku_id, r.status, r.final_qty, r.recommended_qty, coalesce(r.ai_flag, r.rule_flag) AS flag,
            ru.latest_week, to_char(ru.as_of_date,'YYYY-MM-DD') AS as_of_date, ru.started_at,
            (r.metrics->>'min_weeks')::float AS min_weeks, (r.metrics->>'max_weeks')::float AS max_weeks,
            (r.metrics->>'weekly_demand')::float AS weekly_demand
       FROM recommendations r JOIN runs ru ON ru.id = r.run_id
      WHERE r.status IN ('approved','rejected') AND ru.latest_week IS NOT NULL AND ru.as_of_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.recommendation_id = r.id)
        ${LATEST_DECISION_ONLY}`
  );
  let scored = 0;
  for (const l of lines) {
    const sales = await all<{ week: string; units_sold: number }>(`SELECT week, units_sold FROM weekly_sales WHERE sku_id = $1`, [l.sku_id]);
    const after = sales.filter((s) => compareWeeks(s.week, l.latest_week) > 0).map((s) => s.units_sold);
    const next = await one<{ as_of: string; on_hand: string }>(
      `SELECT to_char(as_of_date,'YYYY-MM-DD') AS as_of, sum(units_on_hand) AS on_hand FROM inventory_history
        WHERE sku_id = $1 AND as_of_date > $2::date GROUP BY as_of_date ORDER BY as_of_date LIMIT 1`,
      [l.sku_id, l.as_of_date]
    );
    const reported = next
      ? !!(await one(`SELECT 1 FROM stockout_reports WHERE sku_id = $1 AND reported_at >= $2 AND reported_at::date <= $3::date`, [l.sku_id, l.started_at, next.as_of]))
      : false;
    const s = scoreOutcome({
      flag: l.flag, status: l.status, finalQty: l.final_qty, recommendedQty: l.recommended_qty,
      minWeeks: l.min_weeks, maxWeeks: l.max_weeks, forecastWeeklyDemand: l.weekly_demand,
      salesAfter: after, next: next ? { asOf: next.as_of, onHand: Number(next.on_hand) } : null, stockoutReported: reported,
    });
    if (!s) continue;
    await exec(
      `INSERT INTO outcomes (recommendation_id, weeks_observed, forecast_weekly_demand, actual_weekly_demand, demand_error_pct,
         next_as_of, next_on_hand, next_cover, stock_state, verdict, who_was_right, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (recommendation_id) DO NOTHING`,
      [l.id, s.weeksObserved, l.weekly_demand, s.actualWeeklyDemand, s.demandErrorPct, next!.as_of, Number(next!.on_hand), s.nextCover, s.stockState, s.verdict, s.whoWasRight, s.detail]
    );
    scored++;
  }
  return { scored, waiting: lines.length - scored };
}

// ---- Drafting lessons and calibration proposals ----------------------------------

async function propose(p: { kind: "lesson" | "calibration"; source: string; key: string; text: string; evidence?: unknown; patch?: Partial<Rubric> }) {
  await exec(
    `INSERT INTO lessons (kind, source, dedupe_key, text, evidence, patch) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [p.kind, p.source, p.key, p.text, p.evidence ? JSON.stringify(p.evidence) : null, p.patch ? JSON.stringify(p.patch) : null]
  );
}

export const REASON_TAGS: Record<string, string> = {
  demand_signal: "Demand signal the data doesn't show",
  distributor_scheme: "Distributor or competitor scheme",
  supply_issue: "Supply or lead-time issue",
  data_wrong: "The data is wrong",
  other: "Other",
};

export async function draftProposals(rubric: Rubric): Promise<number> {
  const before = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM lessons`))?.n ?? 0);

  // 1. Raghav overrode the same SKU for the same kind of reason twice or more in 28 days.
  const overrides = await all<{ sku_id: string; name: string; tag: string; n: string; reasons: string[] }>(
    `SELECT r.sku_id, s.name, coalesce(r.reason_tag,'other') AS tag, count(*) AS n,
            array_agg(r.decision_reason ORDER BY r.decided_at DESC) AS reasons
       FROM recommendations r JOIN skus s ON s.sku_id = r.sku_id
      WHERE r.decided_at > now() - interval '28 days'
        AND (r.status = 'rejected' OR (r.status = 'approved' AND r.final_qty <> r.recommended_qty))
      GROUP BY r.sku_id, s.name, coalesce(r.reason_tag,'other') HAVING count(*) >= 2`
  );
  for (const o of overrides) {
    const reasons = o.reasons.filter(Boolean).slice(0, 3);
    await propose({
      kind: "lesson", source: "overrides", key: `override:${o.sku_id}:${o.tag}`,
      text: `${o.name} (${o.sku_id}): Raghav has overridden this ${o.n} times for "${REASON_TAGS[o.tag] ?? o.tag}". Recent reasons: ${reasons.map((x) => `"${x}"`).join("; ")}. Flag it for Raghav when the same signal appears.`,
      evidence: { count: Number(o.n), reasons },
    });
  }

  // 2. A miss: the stock ran short or over after the decision.
  const misses = await all<{ id: number; sku_id: string; name: string; verdict: Verdict; detail: string; run_id: number; perishability: string; next_as_of: string }>(
    `SELECT r.id, r.sku_id, s.name, o.verdict, o.detail, r.run_id, s.perishability, to_char(o.next_as_of,'YYYY-MM-DD') AS next_as_of FROM outcomes o
       JOIN recommendations r ON r.id = o.recommendation_id JOIN skus s ON s.sku_id = r.sku_id
      WHERE o.verdict IN ('missed_stockout','short_after_order','missed_overstock') AND o.scored_at > now() - interval '28 days'`
  );
  for (const m of misses) {
    await propose({
      kind: "lesson", source: "outcome", key: `outcome:${m.sku_id}:${m.verdict}:${m.next_as_of}`,
      text: `${m.name} (${m.sku_id}), run #${m.run_id}: ${VERDICT_LABEL[m.verdict].toLowerCase()}. ${m.detail} Treat similar ${m.perishability === "High" ? "fresh " : ""}cases as an exception.`,
      evidence: { recommendation_id: m.id, verdict: m.verdict },
    });
  }

  // 3. Festival uplift calibration: consistent demand bias in festival runs.
  const fest = await one<{ n: string; runs: string; bias: number | null }>(
    `SELECT count(*) AS n, count(DISTINCT r.run_id) AS runs, avg(o.demand_error_pct) AS bias
       FROM outcomes o JOIN recommendations r ON r.id = o.recommendation_id JOIN runs ru ON ru.id = r.run_id
      WHERE ru.festival AND o.demand_error_pct IS NOT NULL AND o.scored_at > now() - interval '120 days'`
  );
  if (fest && Number(fest.n) >= 6 && Number(fest.runs) >= 2 && fest.bias !== null && Math.abs(fest.bias) > 10) {
    const u = rubric.festival_uplift_pct / 100;
    const target = Math.round((((1 + u) / (1 + fest.bias / 100) - 1) * 100) / 5) * 5;
    if (target !== rubric.festival_uplift_pct && target >= 0 && target <= 100) {
      await propose({
        kind: "calibration", source: "festival_bias", key: `cal:festival_uplift:${target}`,
        text: `Festival demand was ${fest.bias < 0 ? "under" : "over"}-forecast by ${Math.abs(Math.round(fest.bias))}% on average (${fest.n} lines, ${fest.runs} runs). Change the festival uplift from ${rubric.festival_uplift_pct}% to ${target}%.`,
        evidence: { lines: Number(fest.n), runs: Number(fest.runs), bias_pct: Math.round(fest.bias * 10) / 10 },
        patch: { festival_uplift_pct: target },
      });
    }
  }

  // 4. Fresh SKUs keep running short: raise their minimum cover.
  const freshShort = await one<{ n: string }>(
    `SELECT count(*) AS n FROM outcomes o JOIN recommendations r ON r.id = o.recommendation_id JOIN skus s ON s.sku_id = r.sku_id
      WHERE s.perishability = 'High' AND o.verdict IN ('missed_stockout','short_after_order') AND o.scored_at > now() - interval '60 days'`
  );
  if (Number(freshShort?.n ?? 0) >= 2) {
    const min = rubric.high_perish_min_weeks + 1;
    const max = Math.max(rubric.high_perish_max_weeks, min + 1);
    await propose({
      kind: "calibration", source: "fresh_short", key: `cal:fresh_min:${min}:${max}`,
      text: `Fresh SKUs ran short ${freshShort!.n} times in 60 days. Raise their minimum cover from ${rubric.high_perish_min_weeks} to ${min} weeks${max !== rubric.high_perish_max_weeks ? ` and the maximum to ${max}` : ""}.`,
      evidence: { short_count: Number(freshShort!.n) },
      patch: { high_perish_min_weeks: min, high_perish_max_weeks: max },
    });
  }

  const after = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM lessons`))?.n ?? 0);
  return after - before;
}

/** Accepted lessons are part of Gemini's context on every run. */
export async function acceptedLessons(): Promise<string[]> {
  const rows = await all<{ text: string }>(`SELECT text FROM lessons WHERE kind = 'lesson' AND status = 'accepted' ORDER BY decided_at DESC LIMIT 20`);
  return rows.map((r) => r.text);
}

/** Raghav accepts or dismisses a proposal. Accepting a calibration writes a new rubric version. */
export async function decideProposal(id: number, accept: boolean, getRubric: () => Promise<Rubric>, saveRubric: (r: Rubric, note: string) => Promise<number>) {
  const row = await one<{ id: number; kind: string; status: string; text: string; patch: Partial<Rubric> | null }>(`SELECT id, kind, status, text, patch FROM lessons WHERE id = $1`, [id]);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Already ${row.status}.`);
  if (accept && row.kind === "calibration" && row.patch) {
    const v = validateRubric({ ...(await getRubric()), ...row.patch });
    if (!v.ok) throw new Error(`This change would break the rules: ${v.error}`);
    await saveRubric(v.rubric, `Calibration #${row.id}: ${row.text}`);
  }
  await exec(`UPDATE lessons SET status = $2, decided_at = now() WHERE id = $1`, [id, accept ? "accepted" : "dismissed"]);
  await logAudit(accept ? "proposal_accepted" : "proposal_dismissed", { id, kind: row.kind });
}

export async function addLesson(text: string): Promise<void> {
  await exec(`INSERT INTO lessons (kind, status, source, text, decided_at) VALUES ('lesson', 'accepted', 'raghav', $1, now())`, [text.slice(0, 1000)]);
}

// ---- Loop health for the Learning page ---------------------------------------------

export async function loopSummary() {
  const verdicts = await all<{ verdict: Verdict; n: string }>(`SELECT verdict, count(*) AS n FROM outcomes GROUP BY verdict`);
  const totals = await one<{ n: string; bias: number | null; abs_err: number | null }>(
    `SELECT count(*) AS n, avg(demand_error_pct) AS bias, avg(abs(demand_error_pct)) AS abs_err FROM outcomes WHERE demand_error_pct IS NOT NULL`
  );
  const who = await all<{ who_was_right: string; n: string }>(`SELECT who_was_right, count(*) AS n FROM outcomes WHERE who_was_right IS NOT NULL GROUP BY who_was_right`);
  const tags = await all<{ tag: string; n: string }>(
    `SELECT coalesce(reason_tag,'untagged') AS tag, count(*) AS n FROM recommendations
      WHERE status = 'rejected' OR (status = 'approved' AND final_qty <> recommended_qty) GROUP BY 1 ORDER BY 2 DESC`
  );
  const useful = await one<{ yes: string; no: string }>(`SELECT count(*) FILTER (WHERE useful) AS yes, count(*) FILTER (WHERE useful = false) AS no FROM recommendations`);
  const decided = await one<{ n: string; waiting: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.recommendation_id = r.id)) AS waiting
       FROM recommendations r JOIN runs ru ON ru.id = r.run_id WHERE r.status IN ('approved','rejected') ${LATEST_DECISION_ONLY}`
  );
  const proposals = await all(`SELECT id, kind, status, source, text, evidence, patch, created_at, decided_at FROM lessons ORDER BY (status = 'proposed') DESC, created_at DESC LIMIT 50`);
  const recent = await all(
    `SELECT o.recommendation_id, r.sku_id, s.name, s.category, o.verdict, o.stock_state, o.demand_error_pct, o.who_was_right, o.detail, o.scored_at, r.run_id
       FROM outcomes o JOIN recommendations r ON r.id = o.recommendation_id JOIN skus s ON s.sku_id = r.sku_id ORDER BY o.scored_at DESC LIMIT 30`
  );
  const versions = await all(`SELECT version, note, created_at FROM rubric_history ORDER BY version DESC LIMIT 10`);
  const scored = Number(totals?.n ?? 0);
  const right = Number(verdicts.find((v) => v.verdict === "right")?.n ?? 0);
  return {
    scored: verdicts.reduce((t, v) => t + Number(v.n), 0),
    accuracyPct: verdicts.length ? Math.round((right / verdicts.reduce((t, v) => t + Number(v.n), 0)) * 100) : null,
    verdicts: verdicts.map((v) => ({ verdict: v.verdict, label: VERDICT_LABEL[v.verdict], n: Number(v.n) })),
    demandBiasPct: scored && totals?.bias != null ? Math.round(totals.bias * 10) / 10 : null,
    demandAbsErrPct: scored && totals?.abs_err != null ? Math.round(totals.abs_err * 10) / 10 : null,
    whoWasRight: Object.fromEntries(who.map((w) => [w.who_was_right, Number(w.n)])),
    overrideTags: tags.map((t) => ({ tag: t.tag, label: REASON_TAGS[t.tag] ?? "Untagged", n: Number(t.n) })),
    useful: { yes: Number(useful?.yes ?? 0), no: Number(useful?.no ?? 0) },
    decided: Number(decided?.n ?? 0),
    awaitingOutcome: Number(decided?.waiting ?? 0),
    proposals,
    recent,
    rubricVersions: versions,
  };
}
