// Live eval of Gemini against Raghav's rules on the case data. Run: npm run eval
// Golden answers are the rule results (Raghav's documented logic is the spec).
// Pass bar: every flag and action matches, and every line with a known exception is sent to Raghav.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/lib/ingest";
import { cleanAndCompute, DEFAULT_RUBRIC, type SkuMetrics } from "../src/lib/rules";
import { decideBatch, geminiModel, PROMPT_VERSION } from "../src/lib/gemini";

const csv = (f: string) => parseCsv(readFileSync(join(__dirname, "..", "data", f), "utf8")).slice(1);

function caseData(mutate?: (m: SkuMetrics[]) => SkuMetrics[]) {
  const out = cleanAndCompute({
    rubric: DEFAULT_RUBRIC,
    skus: csv("sku_master.csv").map((r) => ({ sku_id: r[0], name: r[1], perishability: r[3], standard_reorder_qty: Number(r[4]), distributor_id: r[6] })),
    sales: csv("weekly_sales.csv").map((r) => ({ sku_id: r[0], week: r[1], units_sold: Number(r[2]) })),
    inventory: csv("current_inventory.csv").map((r) => ({ sku_id: r[0], units_on_hand: Number(r[2]), as_of_date: r[3] })),
    openPos: [],
    festivalFromCalendar: true,
    planningMonth: 10,
  });
  return { ...out, metrics: mutate ? mutate(out.metrics) : out.metrics };
}

async function evaluate(name: string, data: ReturnType<typeof caseData>) {
  const t = Date.now();
  const res = await decideBatch({ rubric: DEFAULT_RUBRIC, festival: data.festival, latestWeek: data.latestWeek, metrics: data.metrics });
  const by = new Map(res.decisions.map((d) => [d.sku_id, d]));
  const misses: string[] = [];
  for (const m of data.metrics) {
    const d = by.get(m.sku_id);
    if (!d) { misses.push(`${m.sku_id}: no decision`); continue; }
    if (d.flag !== m.rule_flag) misses.push(`${m.sku_id}: flag ${d.flag}, expected ${m.rule_flag}`);
    if (d.action !== m.rule_action) misses.push(`${m.sku_id}: action ${d.action}, expected ${m.rule_action}`);
    if (m.exceptions.length && !d.needs_raghav) misses.push(`${m.sku_id}: has exceptions but was not sent to Raghav`);
  }
  console.log(`\n${name}: ${data.metrics.length} SKUs, ${misses.length ? `${misses.length} misses` : "all correct"} (${Date.now() - t} ms, ${res.tokensIn}+${res.tokensOut} tokens)`);
  for (const x of [...misses, ...res.problems]) console.log(`  ✗ ${x}`);
  return misses.length;
}

async function main() {
  console.log(`Eval · model ${geminiModel()} · prompt ${PROMPT_VERSION}`);
  let misses = 0;
  misses += await evaluate("Case data, October (festival)", caseData());
  // Edge: open POs move a fresh SKU from stockout to OK.
  misses += await evaluate("Open PO covers Almond Milk", (() => {
    const input = caseData();
    const m = input.metrics.find((x) => x.sku_id === "SKU004")!;
    return caseData((ms) => ms.map((x) => x.sku_id !== "SKU004" ? x : { ...x, open_po_qty: 200, cover_weeks: 3.8, rule_flag: "OK", rule_action: "NO_ACTION", rule_qty: 0, cover_after_order: null, exceptions: m.exceptions }));
  })());
  console.log(misses ? `\nFAIL: ${misses} misses` : "\nPASS");
  process.exit(misses ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
