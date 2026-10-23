import { all } from "@/lib/db";

export const dynamic = "force-dynamic";

// Approved lines with no PO yet, as a CSV procurement can work from in Zoho.
export async function GET() {
  const rows = await all<{ sku_id: string; name: string; distributor_id: string; final_qty: number; action: string; decided_at: string }>(
    `SELECT r.sku_id, s.name, s.distributor_id, r.final_qty, coalesce(r.ai_action, r.rule_action) AS action,
            to_char(r.decided_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS decided_at
       FROM recommendations r JOIN skus s ON s.sku_id = r.sku_id
      WHERE r.status = 'approved' AND r.final_qty > 0 AND r.po_ref IS NULL
      ORDER BY s.distributor_id, r.sku_id`
  );
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    "SKU_ID,SKU_Name,Distributor_ID,Order_Qty,Action,Approved_At_IST",
    ...rows.map((r) => [r.sku_id, r.name, r.distributor_id, r.final_qty, r.action, r.decided_at].map(esc).join(",")),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="freshroots-approved-orders.csv"`,
    },
  });
}
