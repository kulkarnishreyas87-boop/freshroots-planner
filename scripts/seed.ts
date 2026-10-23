// Loads the sample SAP exports in data/ into Neon. Run: npm run seed
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ingestCsv, type Dataset } from "../src/lib/ingest";
import { getRubric } from "../src/lib/pipeline";
import { closePool } from "../src/lib/db";

const FILES: [Dataset, string][] = [
  ["distributor_master", "distributor_master.csv"],
  ["sku_master", "sku_master.csv"],
  ["calendar", "calendar.csv"],
  ["weekly_sales", "weekly_sales.csv"],
  ["current_inventory", "current_inventory.csv"],
  ["open_pos", "open_pos.csv"],
];

async function main() {
  for (const [dataset, file] of FILES) {
    const path = join(__dirname, "..", "data", file);
    if (!existsSync(path)) {
      console.log(`- ${file}: not found, skipped`);
      continue;
    }
    const res = await ingestCsv(dataset, readFileSync(path, "utf8"));
    console.log(`- ${file}: ${res.loaded} rows loaded${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`);
    for (const s of res.skipped) console.log(`    line ${s.line}: ${s.reason}`);
  }
  await getRubric(); // writes the default rubric on first run
  console.log("Rubric ready.");
  await closePool();
}

main().catch(async (err) => {
  console.error(err.message);
  await closePool();
  process.exit(1);
});
