import { tx } from "./db";

/**
 * Loads the SAP and Zoho CSV exports into Neon. Every file must carry exactly the
 * headers of the sample exports, so a wrongly exported file is refused instead of
 * being loaded half-right.
 */

export const DATASETS = {
  sku_master: ["SKU_ID", "SKU_Name", "Category", "Perishability", "Standard_Reorder_Qty", "Unit_of_Measure", "Distributor_ID"],
  distributor_master: ["Distributor_ID", "Distributor_Name", "Region", "Status"],
  calendar: ["Year", "Month", "Year_Month", "Is_Festival_Month"],
  weekly_sales: ["SKU_ID", "Week", "Units_Sold"],
  current_inventory: ["SKU_ID", "Location", "Units_On_Hand", "As_Of_Date"],
  open_pos: ["PO_Ref", "SKU_ID", "Qty", "Expected_Date"],
} as const;

export type Dataset = keyof typeof DATASETS;

export function isDataset(x: string): x is Dataset {
  return Object.prototype.hasOwnProperty.call(DATASETS, x);
}

/** Minimal CSV parser: handles quoted fields with commas and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

export interface IngestResult {
  dataset: Dataset;
  loaded: number;
  skipped: { line: number; reason: string }[];
}

const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function int(v: string): number | null {
  if (!/^-?\d+$/.test(v)) return null;
  return Number(v);
}

export async function ingestCsv(dataset: Dataset, text: string, opts: { replace?: boolean } = {}): Promise<IngestResult> {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("The file is empty.");
  const expected = DATASETS[dataset];
  const header = rows[0];
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    throw new Error(`Wrong columns for ${dataset}. Expected: ${expected.join(",")}. Got: ${header.join(",")}.`);
  }

  const skipped: IngestResult["skipped"] = [];
  const good: string[][] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.length !== expected.length) return skipped.push({ line, reason: `has ${r.length} columns, expected ${expected.length}` });
    const reason = validate(dataset, r);
    if (reason) skipped.push({ line, reason });
    else good.push(r);
  });

  await tx(async (c) => {
    if (opts.replace) {
      const table = TABLE[dataset];
      await c.query(`DELETE FROM ${table}`);
    }
    for (const r of good) await upsert(c, dataset, r);
  });

  return { dataset, loaded: good.length, skipped };
}

const TABLE: Record<Dataset, string> = {
  sku_master: "skus",
  distributor_master: "distributors",
  calendar: "calendar",
  weekly_sales: "weekly_sales",
  current_inventory: "inventory",
  open_pos: "open_pos",
};

function validate(dataset: Dataset, r: string[]): string | null {
  switch (dataset) {
    case "sku_master": {
      if (!r[0]) return "missing SKU_ID";
      if (!["High", "Low"].includes(r[3])) return `Perishability must be High or Low, got "${r[3]}"`;
      const q = int(r[4]);
      if (q === null || q <= 0) return `Standard_Reorder_Qty must be a positive whole number, got "${r[4]}"`;
      return null;
    }
    case "distributor_master":
      return r[0] ? null : "missing Distributor_ID";
    case "calendar": {
      const y = int(r[0]), m = int(r[1]);
      if (y === null || m === null || m < 1 || m > 12) return "bad Year or Month";
      if (!/^(TRUE|FALSE)$/i.test(r[3])) return `Is_Festival_Month must be TRUE or FALSE, got "${r[3]}"`;
      return null;
    }
    case "weekly_sales": {
      if (!r[0]) return "missing SKU_ID";
      if (!WEEK_RE.test(r[1])) return `Week must look like 2026-W42, got "${r[1]}"`;
      const u = int(r[2]);
      if (u === null || u < 0) return `Units_Sold must be zero or more, got "${r[2]}"`;
      return null;
    }
    case "current_inventory": {
      if (!r[0] || !r[1]) return "missing SKU_ID or Location";
      const u = int(r[2]);
      if (u === null || u < 0) return `Units_On_Hand must be zero or more, got "${r[2]}"`;
      if (!DATE_RE.test(r[3])) return `As_Of_Date must be YYYY-MM-DD, got "${r[3]}"`;
      return null;
    }
    case "open_pos": {
      if (!r[0] || !r[1]) return "missing PO_Ref or SKU_ID";
      const q = int(r[2]);
      if (q === null || q <= 0) return `Qty must be a positive whole number, got "${r[2]}"`;
      if (r[3] && !DATE_RE.test(r[3])) return `Expected_Date must be YYYY-MM-DD, got "${r[3]}"`;
      return null;
    }
  }
}

async function upsert(c: { query: (sql: string, p: unknown[]) => Promise<unknown> }, dataset: Dataset, r: string[]) {
  switch (dataset) {
    case "sku_master":
      return c.query(
        `INSERT INTO skus (sku_id, name, category, perishability, standard_reorder_qty, unit_of_measure, distributor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sku_id) DO UPDATE SET name=excluded.name, category=excluded.category, perishability=excluded.perishability,
           standard_reorder_qty=excluded.standard_reorder_qty, unit_of_measure=excluded.unit_of_measure, distributor_id=excluded.distributor_id`,
        [r[0], r[1], r[2], r[3], Number(r[4]), r[5], r[6]]
      );
    case "distributor_master":
      return c.query(
        `INSERT INTO distributors (distributor_id, name, region, status) VALUES ($1,$2,$3,$4)
         ON CONFLICT (distributor_id) DO UPDATE SET name=excluded.name, region=excluded.region, status=excluded.status`,
        r
      );
    case "calendar":
      return c.query(
        `INSERT INTO calendar (year_month, year, month, is_festival) VALUES ($1,$2,$3,$4)
         ON CONFLICT (year_month) DO UPDATE SET year=excluded.year, month=excluded.month, is_festival=excluded.is_festival`,
        [r[2], Number(r[0]), Number(r[1]), /^TRUE$/i.test(r[3])]
      );
    case "weekly_sales":
      return c.query(
        `INSERT INTO weekly_sales (sku_id, week, units_sold) VALUES ($1,$2,$3)
         ON CONFLICT (sku_id, week) DO UPDATE SET units_sold=excluded.units_sold`,
        [r[0], r[1], Number(r[2])]
      );
    case "current_inventory":
      return c.query(
        `INSERT INTO inventory (sku_id, location, units_on_hand, as_of_date) VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku_id, location) DO UPDATE SET units_on_hand=excluded.units_on_hand, as_of_date=excluded.as_of_date`,
        [r[0], r[1], Number(r[2]), r[3]]
      );
    case "open_pos":
      return c.query(
        `INSERT INTO open_pos (po_ref, sku_id, qty, expected_date) VALUES ($1,$2,$3,$4)
         ON CONFLICT (po_ref, sku_id) DO UPDATE SET qty=excluded.qty, expected_date=excluded.expected_date`,
        [r[0], r[1], Number(r[2]), r[3] || null]
      );
  }
}
