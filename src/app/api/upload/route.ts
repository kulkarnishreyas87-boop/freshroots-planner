import { NextResponse } from "next/server";
import { all, exec, logAudit } from "@/lib/db";
import { DATASETS, ingestCsv, isDataset } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upload an SAP (or Zoho open-PO) CSV export. "replace" clears the table first,
// which is what open POs need: the latest Zoho export is the whole truth.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const dataset = String(form?.get("dataset") ?? "");
  const file = form?.get("file");
  const replace = form?.get("replace") === "true";
  if (!isDataset(dataset)) return NextResponse.json({ error: `Unknown dataset. Use one of: ${Object.keys(DATASETS).join(", ")}` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach a CSV file." }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 20 MB." }, { status: 400 });

  try {
    const res = await ingestCsv(dataset, await file.text(), { replace });
    await logAudit("upload", { dataset, file: file.name, loaded: res.loaded, skipped: res.skipped.length, replace });
    if (dataset === "open_pos" && replace) {
      // From now on this export is the full list of open POs, including ones the app raised.
      await exec(
        `INSERT INTO settings (key, value, updated_at) VALUES ('open_pos_uploaded_at', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [JSON.stringify({ at: new Date().toISOString() })]
      );
    }
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Row counts per table, so the Data page shows what is loaded.
export async function GET() {
  try {
    const rows = await all<{ t: string; n: string; latest: string | null }>(
      `SELECT 'sku_master' AS t, count(*) AS n, NULL AS latest FROM skus
       UNION ALL SELECT 'distributor_master', count(*), NULL FROM distributors
       UNION ALL SELECT 'calendar', count(*), max(year_month) FROM calendar
       UNION ALL SELECT 'weekly_sales', count(*), max(week) FROM weekly_sales
       UNION ALL SELECT 'current_inventory', count(*), to_char(max(as_of_date),'YYYY-MM-DD') FROM inventory
       UNION ALL SELECT 'open_pos', count(*), NULL FROM open_pos`
    );
    return NextResponse.json({
      datasets: Object.entries(DATASETS).map(([name, columns]) => {
        const r = rows.find((x) => x.t === name);
        return { name, columns, rows: Number(r?.n ?? 0), latest: r?.latest ?? null };
      }),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
