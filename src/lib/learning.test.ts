import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOutcome, type ScoreInput } from "./learning";

const base: ScoreInput = {
  flag: "STOCKOUT_RISK", status: "approved", finalQty: 150, recommendedQty: 150,
  minWeeks: 3, maxWeeks: 4, forecastWeeklyDemand: 100,
  salesAfter: [90, 110], next: { asOf: "2026-10-26", onHand: 350 }, stockoutReported: false,
};

test("no later data yet: not scored", () => {
  assert.equal(scoreOutcome({ ...base, salesAfter: [] }), null);
  assert.equal(scoreOutcome({ ...base, next: null }), null);
});

test("ordered and landed in the window: right call, demand error measured", () => {
  const s = scoreOutcome(base)!;
  assert.equal(s.actualWeeklyDemand, 100);
  assert.equal(s.demandErrorPct, 0);
  assert.equal(s.nextCover, 3.5);
  assert.equal(s.stockState, "in_window");
  assert.equal(s.verdict, "right");
  assert.equal(s.whoWasRight, null);
});

test("marked OK but ran out: missed stockout", () => {
  const s = scoreOutcome({ ...base, flag: "OK", status: "approved", finalQty: 0, next: { asOf: "2026-10-26", onHand: 0 } })!;
  assert.equal(s.stockState, "stocked_out");
  assert.equal(s.verdict, "missed_stockout");
});

test("a stockout report counts even when the snapshot shows stock", () => {
  assert.equal(scoreOutcome({ ...base, stockoutReported: true })!.stockState, "stocked_out");
});

test("ordered but still short: short after order", () => {
  const s = scoreOutcome({ ...base, salesAfter: [160, 170], next: { asOf: "2026-10-26", onHand: 300 } })!;
  assert.equal(s.stockState, "under_window");
  assert.equal(s.verdict, "short_after_order");
  assert.ok(s.demandErrorPct! < -35); // demand was under-forecast
});

test("ordered and ended over the window: unnecessary order", () => {
  assert.equal(scoreOutcome({ ...base, next: { asOf: "2026-10-26", onHand: 900 } })!.verdict, "unnecessary_order");
});

test("Raghav rejected a stockout flag and stock stayed fine: Raghav was right", () => {
  const s = scoreOutcome({ ...base, status: "rejected", finalQty: null })!;
  assert.equal(s.verdict, "right");
  assert.equal(s.whoWasRight, "raghav");
});

test("Raghav rejected a stockout flag and it ran out: the system was right", () => {
  const s = scoreOutcome({ ...base, status: "rejected", finalQty: null, next: { asOf: "2026-10-26", onHand: 0 } })!;
  assert.equal(s.verdict, "missed_stockout");
  assert.equal(s.whoWasRight, "system");
});

test("flagged stockout, not ordered, stock ended high: false alarm", () => {
  const s = scoreOutcome({ ...base, status: "rejected", finalQty: null, next: { asOf: "2026-10-26", onHand: 800 } })!;
  assert.equal(s.verdict, "false_alarm");
});
