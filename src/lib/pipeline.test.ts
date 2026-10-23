import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDecision } from "./pipeline";
import { DEFAULT_RUBRIC, type SkuMetrics } from "./rules";

const base = {
  sku_id: "SKU004", name: "Almond Milk", perishability: "High", distributor_id: "DIST002", standard_reorder_qty: 150,
  window_weeks: [], weeks_with_data: 12, missing_weeks: [], recent_sales: [], avg_12: 79.8, avg_4: 81, change_pct: 1.5,
  festival: true, weekly_demand: 99.8, on_hand: 180, open_po_qty: 0, cover_weeks: 1.8, min_weeks: 3, max_weeks: 4,
  rule_high_demand: false, rule_flag: "STOCKOUT_RISK", rule_action: "REORDER_STANDARD", rule_qty: 150, cover_after_order: 3.3, exceptions: [],
} satisfies SkuMetrics;

test("agreeing decision is not an exception", () => {
  const r = mergeDecision(base, { sku_id: "SKU004", flag: "STOCKOUT_RISK", high_demand: false, action: "REORDER_STANDARD", needs_raghav: false, raghav_reason: "", reason: "1.8 weeks vs 3 minimum." }, DEFAULT_RUBRIC);
  assert.equal(r.recommended_qty, 150);
  assert.deepEqual(r.exceptions, []);
});

test("Gemini disagreeing with the rules goes to Raghav, qty follows Gemini's action", () => {
  const r = mergeDecision(base, { sku_id: "SKU004", flag: "STOCKOUT_RISK", high_demand: true, action: "REORDER_1_5X", needs_raghav: false, raghav_reason: "", reason: "x" }, DEFAULT_RUBRIC);
  assert.equal(r.recommended_qty, 225);
  assert.equal(r.exceptions.length, 1);
  assert.match(r.exceptions[0], /the rules give STOCKOUT_RISK \/ REORDER_STANDARD/);
});

test("Gemini repeating a code exception is not listed twice; a new concern is", () => {
  const m = { ...base, exceptions: ["Close call: sales are +21.4% vs the 20% high-demand line."] };
  const echo = mergeDecision(m, { sku_id: "SKU004", flag: "STOCKOUT_RISK", high_demand: false, action: "REORDER_STANDARD", needs_raghav: true, raghav_reason: "Close call: sales are +21.4% vs the 20% high-demand line.", reason: "x" }, DEFAULT_RUBRIC);
  assert.equal(echo.exceptions.length, 1);
  const fresh = mergeDecision(m, { sku_id: "SKU004", flag: "STOCKOUT_RISK", high_demand: false, action: "REORDER_STANDARD", needs_raghav: true, raghav_reason: "Sales jumped 40% from W39.", reason: "x" }, DEFAULT_RUBRIC);
  assert.equal(fresh.exceptions.length, 2);
  assert.equal(fresh.exceptions[1], "Gemini: Sales jumped 40% from W39.");
});

test("missing Gemini decision falls back to the rule result as an exception", () => {
  const r = mergeDecision(base, undefined, DEFAULT_RUBRIC);
  assert.equal(r.ai_flag, null);
  assert.equal(r.recommended_qty, 150);
  assert.match(r.exceptions[0], /no decision/);
});
