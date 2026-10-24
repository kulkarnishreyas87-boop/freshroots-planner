/**
 * Raghav's forecast rules (the rubric) and the "data cleaning and structuring" step.
 * Everything here is plain arithmetic with no AI, so the numbers Gemini decides on
 * are exact, and the rule result is kept as a check on Gemini's decision.
 */

export interface Rubric {
  high_demand_threshold_pct: number; // last 4 weeks above the 12-week average by more than this
  high_demand_multiplier: number; // reorder at this multiple of the standard qty
  low_perish_min_weeks: number;
  low_perish_max_weeks: number;
  high_perish_min_weeks: number;
  high_perish_max_weeks: number;
  festival_uplift_pct: number;
  festival_months: number[]; // used only when the calendar has no row for the month
  avg_window_weeks: number;
  recent_window_weeks: number;
  borderline_pct: number; // within this % of a threshold counts as a close call
  judgment_notes: string; // Raghav's notes for the cases the rules don't cover
  kill_reject_rate_pct: number;
  kill_window_days: number;
  kill_min_decisions: number;
  gate_max_inventory_age_days: number; // block the run when stock data is older
  gate_max_sales_age_days: number; // block when the latest sales week ended longer ago
  gate_max_missing_inventory_pct: number; // block when more SKUs than this have no stock row
}

export const DEFAULT_RUBRIC: Rubric = {
  high_demand_threshold_pct: 20,
  high_demand_multiplier: 1.5,
  low_perish_min_weeks: 6,
  low_perish_max_weeks: 14,
  high_perish_min_weeks: 3,
  high_perish_max_weeks: 4,
  festival_uplift_pct: 25,
  festival_months: [3, 10, 11],
  avg_window_weeks: 12,
  recent_window_weeks: 4,
  borderline_pct: 10,
  judgment_notes: "",
  kill_reject_rate_pct: 30,
  kill_window_days: 28,
  kill_min_decisions: 10,
  gate_max_inventory_age_days: 10,
  gate_max_sales_age_days: 21,
  gate_max_missing_inventory_pct: 20,
};

// ---- Data gate ----------------------------------------------------------------

export interface GateResult {
  ok: boolean;
  blockers: string[]; // any blocker stops the run before Gemini
  warnings: string[];
  missingInventory: string[]; // these SKUs skip Gemini and go to Raghav as data issues
  inventoryAgeDays: number | null;
  salesAgeDays: number | null;
}

const DAY = 86_400_000;

export function dataGate(p: {
  rubric: Rubric;
  today: Date;
  skus: { sku_id: string }[];
  latestWeek: string | null;
  inventory: { sku_id: string; as_of_date: string }[];
}): GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const r = p.rubric;

  if (p.skus.length === 0) blockers.push("No SKUs loaded. Upload the SKU master.");
  if (!p.latestWeek) blockers.push("No weekly sales loaded. Upload weekly_sales.");

  let salesAge: number | null = null;
  if (p.latestWeek) {
    const weekEnd = weekMonday(p.latestWeek).getTime() + 7 * DAY; // Monday after the week
    salesAge = Math.floor((p.today.getTime() - weekEnd) / DAY);
    if (salesAge > r.gate_max_sales_age_days) blockers.push(`Latest sales week ${p.latestWeek} ended ${salesAge} days ago (limit ${r.gate_max_sales_age_days}). Upload newer sales.`);
  }

  const asOf = p.inventory.map((i) => i.as_of_date).sort().at(-1);
  let invAge: number | null = null;
  if (!asOf) blockers.push("No inventory loaded. Upload current_inventory.");
  else {
    invAge = Math.floor((p.today.getTime() - Date.parse(`${asOf}T00:00:00Z`)) / DAY);
    if (invAge > r.gate_max_inventory_age_days) blockers.push(`Inventory is from ${asOf}, ${invAge} days old (limit ${r.gate_max_inventory_age_days}). Upload a fresh snapshot.`);
    const stale = new Set(p.inventory.filter((i) => i.as_of_date < asOf).map((i) => i.sku_id));
    if (stale.size) warnings.push(`Older stock rows than ${asOf} for ${[...stale].join(", ")}.`);
  }

  const have = new Set(p.inventory.map((i) => i.sku_id));
  const missing = p.skus.map((s) => s.sku_id).filter((id) => !have.has(id));
  if (p.skus.length && missing.length) {
    const pct = (missing.length / p.skus.length) * 100;
    if (pct > r.gate_max_missing_inventory_pct) blockers.push(`${missing.length} of ${p.skus.length} SKUs have no inventory row (${Math.round(pct)}%, limit ${r.gate_max_missing_inventory_pct}%). The export looks incomplete.`);
    else warnings.push(`No inventory row for ${missing.join(", ")}: sent to Raghav as data issues, not decided by Gemini.`);
  }

  return { ok: blockers.length === 0, blockers, warnings, missingInventory: missing, inventoryAgeDays: invAge, salesAgeDays: salesAge };
}

export type Flag = "STOCKOUT_RISK" | "OVERSTOCK_RISK" | "OK";
export type Action = "REORDER_STANDARD" | "REORDER_1_5X" | "PAUSE_NEXT_ORDER" | "NO_ACTION";
export const FLAGS: Flag[] = ["STOCKOUT_RISK", "OVERSTOCK_RISK", "OK"];
export const ACTIONS: Action[] = ["REORDER_STANDARD", "REORDER_1_5X", "PAUSE_NEXT_ORDER", "NO_ACTION"];

export interface SkuRow {
  sku_id: string;
  name: string;
  perishability: string;
  standard_reorder_qty: number;
  distributor_id: string | null;
}

export interface SkuMetrics {
  sku_id: string;
  name: string;
  perishability: string;
  distributor_id: string | null;
  standard_reorder_qty: number;
  window_weeks: string[]; // the 12 weeks the average covers, oldest first
  weeks_with_data: number;
  missing_weeks: string[];
  recent_sales: { week: string; units: number }[]; // last 16 weeks with data, oldest first
  avg_12: number | null;
  avg_4: number | null;
  change_pct: number | null; // last-4 average vs 12-week average
  festival: boolean;
  weekly_demand: number | null; // 12-week average with festival uplift
  on_hand: number | null;
  open_po_qty: number;
  cover_weeks: number | null; // (on hand + open POs) / weekly demand
  min_weeks: number;
  max_weeks: number;
  rule_high_demand: boolean;
  rule_flag: Flag;
  rule_action: Action;
  rule_qty: number;
  cover_after_order: number | null;
  exceptions: string[]; // reasons this SKU goes to Raghav regardless of the decision
}

// ---- ISO week helpers -------------------------------------------------------

export function parseWeek(w: string): { year: number; week: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(w);
  if (!m) throw new Error(`Bad week "${w}"`);
  return { year: Number(m[1]), week: Number(m[2]) };
}

/** Monday of an ISO week, as a UTC date. */
export function weekMonday(w: string): Date {
  const { year, week } = parseWeek(w);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1) + (week - 1) * 7);
  return monday;
}

export function dateToWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday decides the ISO year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function shiftWeek(w: string, by: number): string {
  const d = weekMonday(w);
  d.setUTCDate(d.getUTCDate() + by * 7);
  return dateToWeek(d);
}

export function compareWeeks(a: string, b: string): number {
  return weekMonday(a).getTime() - weekMonday(b).getTime();
}

// ---- The cleaning + rules step ----------------------------------------------

export interface CleanInput {
  rubric: Rubric;
  skus: SkuRow[];
  sales: { sku_id: string; week: string; units_sold: number }[];
  inventory: { sku_id: string; units_on_hand: number; as_of_date: string }[];
  openPos: { sku_id: string; qty: number }[];
  festivalFromCalendar: boolean | null; // null when the calendar has no row for the planning month
  planningMonth: number; // 1-12
}

export interface CleanOutput {
  latestWeek: string;
  festival: boolean;
  festivalSource: "calendar" | "rubric";
  metrics: SkuMetrics[];
  dataIssues: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function cleanAndCompute(input: CleanInput): CleanOutput {
  const { rubric } = input;
  const dataIssues: string[] = [];
  if (input.sales.length === 0) throw new Error("No weekly sales loaded. Upload the SAP weekly_sales export first.");
  if (input.skus.length === 0) throw new Error("No SKUs loaded. Upload the SAP sku_master export first.");

  const latestWeek = input.sales.map((s) => s.week).sort(compareWeeks).at(-1)!;
  const windowWeeks = Array.from({ length: rubric.avg_window_weeks }, (_, i) => shiftWeek(latestWeek, i - rubric.avg_window_weeks + 1));
  const recentWeeks = new Set(windowWeeks.slice(-rubric.recent_window_weeks));

  const festival = input.festivalFromCalendar ?? rubric.festival_months.includes(input.planningMonth);
  const festivalSource = input.festivalFromCalendar === null ? "rubric" : "calendar";
  if (input.festivalFromCalendar === null) {
    dataIssues.push(`The calendar has no row for month ${input.planningMonth}; used the rubric's festival months instead.`);
  }

  const known = new Set(input.skus.map((s) => s.sku_id));
  const unknownSales = new Set(input.sales.filter((s) => !known.has(s.sku_id)).map((s) => s.sku_id));
  if (unknownSales.size) dataIssues.push(`Sales rows for SKUs not in the SKU master were ignored: ${[...unknownSales].join(", ")}.`);
  const unknownInv = new Set(input.inventory.filter((s) => !known.has(s.sku_id)).map((s) => s.sku_id));
  if (unknownInv.size) dataIssues.push(`Inventory rows for SKUs not in the SKU master were ignored: ${[...unknownInv].join(", ")}.`);

  const metrics = input.skus.map((sku): SkuMetrics => {
    const exceptions: string[] = [];
    const mine = input.sales.filter((s) => s.sku_id === sku.sku_id);
    const byWeek = new Map(mine.map((s) => [s.week, s.units_sold]));
    const inWindow = windowWeeks.filter((w) => byWeek.has(w));
    const missing = windowWeeks.filter((w) => !byWeek.has(w));
    const recentInWindow = inWindow.filter((w) => recentWeeks.has(w));

    // Missing weeks are left out of the average, never counted as zero sales.
    const avg = (ws: string[]) => (ws.length ? ws.reduce((t, w) => t + byWeek.get(w)!, 0) / ws.length : null);
    const avg12 = avg(inWindow);
    const avg4 = avg(recentInWindow);
    const change = avg12 && avg4 !== null ? ((avg4 - avg12) / avg12) * 100 : null;

    if (missing.length) {
      exceptions.push(
        inWindow.length < rubric.avg_window_weeks / 2
          ? `Only ${inWindow.length} of ${rubric.avg_window_weeks} weeks of sales (new launch or missing data). The rules need a full history.`
          : `Sales missing for ${missing.join(", ")}. Averages use the ${inWindow.length} weeks that exist.`
      );
    }

    const isHigh = sku.perishability === "High";
    const minW = isHigh ? rubric.high_perish_min_weeks : rubric.low_perish_min_weeks;
    const maxW = isHigh ? rubric.high_perish_max_weeks : rubric.low_perish_max_weeks;

    const weeklyDemand = avg12 !== null ? avg12 * (festival ? 1 + rubric.festival_uplift_pct / 100 : 1) : null;
    const inv = input.inventory.filter((i) => i.sku_id === sku.sku_id);
    const onHand = inv.length ? inv.reduce((t, i) => t + i.units_on_hand, 0) : null;
    if (onHand === null) exceptions.push("No inventory row for this SKU in the SAP export.");
    const openPo = input.openPos.filter((p) => p.sku_id === sku.sku_id).reduce((t, p) => t + p.qty, 0);

    let cover: number | null = null;
    if (onHand !== null && weeklyDemand !== null) {
      if (weeklyDemand > 0) cover = (onHand + openPo) / weeklyDemand;
      else exceptions.push("No sales in the averaging window, so weeks of cover cannot be calculated.");
    }

    const highDemand = change !== null && change > rubric.high_demand_threshold_pct;
    let ruleFlag: Flag = "OK";
    if (cover !== null && cover < minW) ruleFlag = "STOCKOUT_RISK";
    else if (cover !== null && cover > maxW) ruleFlag = "OVERSTOCK_RISK";

    let ruleAction: Action = "NO_ACTION";
    if (ruleFlag === "OVERSTOCK_RISK") ruleAction = "PAUSE_NEXT_ORDER";
    else if (highDemand) ruleAction = "REORDER_1_5X"; // rule 1 recommends 1.5x on its own
    else if (ruleFlag === "STOCKOUT_RISK") ruleAction = "REORDER_STANDARD";

    if (highDemand && ruleFlag === "OVERSTOCK_RISK") {
      exceptions.push("High demand and overstock at the same time: the rules disagree, so Raghav decides.");
    }

    const ruleQty = qtyFor(ruleAction, sku.standard_reorder_qty, rubric);
    const coverAfter = cover !== null && weeklyDemand ? cover + ruleQty / weeklyDemand : null;
    if (ruleQty > 0 && coverAfter !== null && coverAfter < minW) {
      // Two decimals: 5.95 must not print as "6 weeks, under the 6-week minimum".
      exceptions.push(`After the recommended ${ruleQty} units, cover is still ${coverAfter.toFixed(2)} weeks, under the ${minW}-week minimum.`);
    }

    const near = (v: number, t: number) => Math.abs(v - t) <= (t * rubric.borderline_pct) / 100;
    if (cover !== null && (near(cover, minW) || near(cover, maxW))) {
      exceptions.push(`Close call: ${round1(cover)} weeks of cover is within ${rubric.borderline_pct}% of the ${near(cover, minW) ? minW : maxW}-week limit.`);
    }
    if (change !== null && near(change, rubric.high_demand_threshold_pct)) {
      exceptions.push(`Close call: sales are ${change >= 0 ? "+" : ""}${round1(change)}% vs the ${rubric.high_demand_threshold_pct}% high-demand line.`);
    }

    const recent = mine
      .slice()
      .sort((a, b) => compareWeeks(a.week, b.week))
      .slice(-16)
      .map((s) => ({ week: s.week, units: s.units_sold }));

    return {
      sku_id: sku.sku_id,
      name: sku.name,
      perishability: sku.perishability,
      distributor_id: sku.distributor_id,
      standard_reorder_qty: sku.standard_reorder_qty,
      window_weeks: windowWeeks,
      weeks_with_data: inWindow.length,
      missing_weeks: missing,
      recent_sales: recent,
      avg_12: avg12 === null ? null : round1(avg12),
      avg_4: avg4 === null ? null : round1(avg4),
      change_pct: change === null ? null : round1(change),
      festival,
      weekly_demand: weeklyDemand === null ? null : round1(weeklyDemand),
      on_hand: onHand,
      open_po_qty: openPo,
      cover_weeks: cover === null ? null : round1(cover),
      min_weeks: minW,
      max_weeks: maxW,
      rule_high_demand: highDemand,
      rule_flag: ruleFlag,
      rule_action: ruleAction,
      rule_qty: ruleQty,
      cover_after_order: coverAfter === null ? null : round1(coverAfter),
      exceptions,
    };
  });

  return { latestWeek, festival, festivalSource, metrics, dataIssues };
}

export function qtyFor(action: Action, standardQty: number, rubric: Rubric): number {
  if (action === "REORDER_STANDARD") return standardQty;
  if (action === "REORDER_1_5X") return Math.round(standardQty * rubric.high_demand_multiplier);
  return 0;
}

/** Checks a rubric sent from the Rules page; returns the cleaned rubric or an error message. */
export function validateRubric(x: unknown): { ok: true; rubric: Rubric } | { ok: false; error: string } {
  if (!x || typeof x !== "object") return { ok: false, error: "Rubric must be an object." };
  const o = x as Record<string, unknown>;
  const out = { ...DEFAULT_RUBRIC };
  for (const key of Object.keys(DEFAULT_RUBRIC) as (keyof Rubric)[]) {
    const v = o[key];
    if (v === undefined) continue;
    if (key === "judgment_notes") {
      if (typeof v !== "string") return { ok: false, error: "judgment_notes must be text." };
      out.judgment_notes = v.slice(0, 4000);
    } else if (key === "festival_months") {
      if (!Array.isArray(v) || v.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
        return { ok: false, error: "festival_months must be a list of month numbers 1-12." };
      }
      out.festival_months = v as number[];
    } else {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, error: `${key} must be a number, zero or more.` };
      (out as Record<string, unknown>)[key] = v;
    }
  }
  if (out.gate_max_inventory_age_days < 1 || out.gate_max_sales_age_days < 7) return { ok: false, error: "Data gate limits are too tight: inventory at least 1 day, sales at least 7 days." };
  if (out.low_perish_min_weeks >= out.low_perish_max_weeks) return { ok: false, error: "Low perishability: minimum weeks must be below maximum." };
  if (out.high_perish_min_weeks >= out.high_perish_max_weeks) return { ok: false, error: "High perishability: minimum weeks must be below maximum." };
  if (!Number.isInteger(out.avg_window_weeks) || !Number.isInteger(out.recent_window_weeks) || out.recent_window_weeks < 1 || out.recent_window_weeks >= out.avg_window_weeks) {
    return { ok: false, error: "Averaging windows must be whole weeks, and the recent window shorter than the long one." };
  }
  return { ok: true, rubric: out };
}
