import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./ingest";
import { cleanAndCompute, dataGate, DEFAULT_RUBRIC, shiftWeek, dateToWeek, type CleanInput } from "./rules";

const csv = (f: string) => parseCsv(readFileSync(join(__dirname, "../../data", f), "utf8")).slice(1);

function sampleInput(): CleanInput {
  return {
    rubric: DEFAULT_RUBRIC,
    skus: csv("sku_master.csv").map((r) => ({ sku_id: r[0], name: r[1], perishability: r[3], standard_reorder_qty: Number(r[4]), distributor_id: r[6] })),
    sales: csv("weekly_sales.csv").map((r) => ({ sku_id: r[0], week: r[1], units_sold: Number(r[2]) })),
    inventory: csv("current_inventory.csv").map((r) => ({ sku_id: r[0], units_on_hand: Number(r[2]), as_of_date: r[3] })),
    openPos: [],
    festivalFromCalendar: true, // calendar.csv: 2026-10 is a festival month
    planningMonth: 10,
  };
}

test("ISO week helpers", () => {
  assert.equal(shiftWeek("2026-W42", -11), "2026-W31");
  assert.equal(shiftWeek("2026-W01", -1), "2025-W52");
  assert.equal(dateToWeek(new Date(Date.UTC(2026, 9, 19))), "2026-W43");
});

test("sample data gives the flags from the analysis", () => {
  const out = cleanAndCompute(sampleInput());
  assert.equal(out.latestWeek, "2026-W42");
  assert.equal(out.festival, true);
  const by = Object.fromEntries(out.metrics.map((m) => [m.sku_id, m]));

  const stockout = out.metrics.filter((m) => m.rule_flag === "STOCKOUT_RISK").map((m) => m.sku_id).sort();
  assert.deepEqual(stockout, ["SKU001", "SKU003", "SKU004", "SKU011", "SKU013"]);
  const overstock = out.metrics.filter((m) => m.rule_flag === "OVERSTOCK_RISK").map((m) => m.sku_id).sort();
  assert.deepEqual(overstock, ["SKU006", "SKU007"]);

  assert.equal(by.SKU001.avg_12, 214.9);
  assert.equal(by.SKU001.change_pct, 21.4);
  assert.equal(by.SKU001.rule_action, "REORDER_1_5X");
  assert.equal(by.SKU001.rule_qty, 750);
  assert.equal(by.SKU004.cover_weeks, 1.8);
  assert.equal(by.SKU011.cover_weeks, 1.8);
  assert.equal(by.SKU007.cover_weeks, 4.1);
  assert.equal(by.SKU006.cover_weeks, 22.2);

  // Exceptions called out in the analysis
  assert.ok(by.SKU001.exceptions.some((e) => e.includes("high-demand line")));
  assert.ok(by.SKU007.exceptions.some((e) => e.includes("4-week limit")));
  assert.ok(by.SKU013.exceptions.some((e) => e.includes("still")));
  assert.ok(by.SKU003.exceptions.some((e) => e.includes("still")));
  assert.equal(by.SKU002.exceptions.length, 0);
});

test("missing weeks are left out of the average, not counted as zero", () => {
  const input = sampleInput();
  input.sales = input.sales.filter((s) => !(s.sku_id === "SKU010" && s.week === "2026-W35"));
  const m = cleanAndCompute(input).metrics.find((x) => x.sku_id === "SKU010")!;
  assert.equal(m.weeks_with_data, 11);
  assert.deepEqual(m.missing_weeks, ["2026-W35"]);
  assert.ok(m.avg_12! > 23 && m.avg_12! < 26);
  assert.ok(m.exceptions.some((e) => e.includes("2026-W35")));
});

test("data gate: fresh sample data passes; one missing SKU is a warning, not a guess", () => {
  const input = sampleInput();
  const inv = input.inventory.filter((i) => i.sku_id !== "SKU009");
  const g = dataGate({ rubric: DEFAULT_RUBRIC, today: new Date(Date.UTC(2026, 9, 24)), skus: input.skus, latestWeek: "2026-W42", inventory: inv });
  assert.equal(g.ok, true);
  assert.deepEqual(g.missingInventory, ["SKU009"]);
  assert.equal(g.inventoryAgeDays, 5);
  assert.equal(g.salesAgeDays, 5);
  assert.match(g.warnings.join(" "), /SKU009/);
});

test("data gate blocks stale or incomplete data", () => {
  const input = sampleInput();
  const stale = dataGate({ rubric: DEFAULT_RUBRIC, today: new Date(Date.UTC(2026, 10, 20)), skus: input.skus, latestWeek: "2026-W42", inventory: input.inventory });
  assert.equal(stale.ok, false);
  assert.match(stale.blockers.join(" "), /Inventory is from 2026-10-19/);
  assert.match(stale.blockers.join(" "), /2026-W42 ended/);
  const holes = dataGate({ rubric: DEFAULT_RUBRIC, today: new Date(Date.UTC(2026, 9, 24)), skus: input.skus, latestWeek: "2026-W42", inventory: input.inventory.slice(0, 10) });
  assert.equal(holes.ok, false);
  assert.match(holes.blockers[0], /5 of 15 SKUs have no inventory row/);
});

test("open POs count toward cover", () => {
  const input = sampleInput();
  input.openPos = [{ sku_id: "SKU004", qty: 200 }];
  const m = cleanAndCompute(input).metrics.find((x) => x.sku_id === "SKU004")!;
  assert.equal(m.cover_weeks, 3.8);
  assert.equal(m.rule_flag, "OK");
});
