import { all, exec, one, logAudit } from "./db";
import { getKillSwitch } from "./pipeline";
import { createPurchaseOrder, findItemBySku, markIssued, zohoConfigured, ZohoError } from "./zoho";

/**
 * The PO layer: once Raghav approves a line with a quantity, the PO is raised in Zoho.
 * A line is claimed (zoho_status = 'creating') before the call, so a double click or two
 * tabs can never raise two POs for the same approval.
 */

export interface PoOutcome {
  id: number;
  status: "created" | "failed" | "skipped";
  message: string;
  poNumber?: string;
}

export function poStatusAfterCreate(): "draft" | "issued" {
  return process.env.ZOHO_PO_STATUS?.trim().toLowerCase() === "issued" ? "issued" : "draft";
}

function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Item id for an SKU: saved mapping first, else an exact SKU match in Zoho (then saved). */
async function itemFor(skuId: string): Promise<{ id: string; rate: number | null } | null> {
  const saved = await one<{ zoho_id: string; purchase_rate: number | null }>(
    `SELECT zoho_id, purchase_rate FROM zoho_map WHERE kind = 'item' AND local_id = $1`,
    [skuId]
  );
  if (saved) return { id: saved.zoho_id, rate: saved.purchase_rate };
  const item = await findItemBySku(skuId);
  if (!item) return null;
  await exec(
    `INSERT INTO zoho_map (kind, local_id, zoho_id, zoho_name, purchase_rate) VALUES ('item', $1, $2, $3, $4)
     ON CONFLICT (kind, local_id) DO UPDATE SET zoho_id = excluded.zoho_id, zoho_name = excluded.zoho_name, purchase_rate = excluded.purchase_rate, updated_at = now()`,
    [skuId, item.item_id, item.name, item.purchase_rate]
  );
  return { id: item.item_id, rate: item.purchase_rate };
}

export async function raisePo(lineId: number): Promise<PoOutcome> {
  if (!zohoConfigured()) return { id: lineId, status: "skipped", message: "Zoho is not connected; record the PO number by hand." };

  const ks = await getKillSwitch();
  if (ks.paused) {
    await exec(`UPDATE recommendations SET zoho_status = 'failed', zoho_error = $2 WHERE id = $1 AND po_ref IS NULL`, [lineId, "Kill switch is on: no POs are raised until runs resume."]);
    return { id: lineId, status: "failed", message: "Kill switch is on: no POs are raised until runs resume." };
  }

  // Claim the line. Only an approved line with a quantity, no PO yet, and not already being raised.
  const line = await one<{ id: number; run_id: number; sku_id: string; final_qty: number; distributor_id: string | null; name: string; decision_reason: string | null }>(
    `UPDATE recommendations r SET zoho_status = 'creating', zoho_error = NULL
       FROM skus s
      WHERE r.id = $1 AND s.sku_id = r.sku_id AND r.status = 'approved' AND r.final_qty > 0
        AND r.po_ref IS NULL AND coalesce(r.zoho_status, '') IN ('', 'failed')
      RETURNING r.id, r.run_id, r.sku_id, r.final_qty, s.distributor_id, s.name, r.decision_reason`,
    [lineId]
  );
  if (!line) return { id: lineId, status: "skipped", message: "Line is not an approved order waiting for a PO, or a PO is already being raised." };

  const reference = `FR-R${line.run_id}-${line.sku_id}-L${line.id}`;
  const fail = async (msg: string) => {
    await exec(`UPDATE recommendations SET zoho_status = 'failed', zoho_error = $2, zoho_reference = $3 WHERE id = $1`, [line.id, msg, reference]);
    await logAudit("zoho_po_failed", { id: line.id, msg });
    return { id: line.id, status: "failed" as const, message: msg };
  };

  try {
    const item = await itemFor(line.sku_id);
    if (!item) return fail(`No Zoho item has SKU "${line.sku_id}". Map it on the Zoho page.`);
    const vendor = line.distributor_id
      ? await one<{ zoho_id: string }>(`SELECT zoho_id FROM zoho_map WHERE kind = 'vendor' AND local_id = $1`, [line.distributor_id])
      : undefined;
    if (!vendor) return fail(`Distributor ${line.distributor_id ?? "(none)"} is not mapped to a Zoho vendor. Map it on the Zoho page.`);

    const po = await createPurchaseOrder({
      vendorId: vendor.zoho_id,
      itemId: item.id,
      quantity: line.final_qty,
      purchaseRate: item.rate,
      date: todayIST(),
      reference,
      notes: `Freshroots Demand Planner: ${line.name}, approved by Raghav${line.decision_reason ? ` (${line.decision_reason})` : ""}.`,
    });

    await exec(
      `UPDATE recommendations SET zoho_status = 'created', zoho_po_id = $2, po_ref = $3, po_placed_at = now(), zoho_reference = $4, zoho_error = NULL WHERE id = $1`,
      [line.id, po.purchaseorder_id, po.purchaseorder_number || po.purchaseorder_id, reference]
    );
    await logAudit("zoho_po_created", { id: line.id, po });

    if (poStatusAfterCreate() === "issued") {
      try {
        await markIssued(po.purchaseorder_id);
      } catch (err) {
        await exec(`UPDATE recommendations SET zoho_error = $2 WHERE id = $1`, [line.id, `PO created but not marked issued: ${(err as Error).message}`]);
      }
    }
    return { id: line.id, status: "created", message: `PO ${po.purchaseorder_number} raised in Zoho.`, poNumber: po.purchaseorder_number };
  } catch (err) {
    const e = err as Error;
    // A timeout may mean Zoho created the PO but the reply was lost.
    const unsure = e.name === "TimeoutError" || e.name === "AbortError" || (e instanceof ZohoError && (e.status ?? 0) >= 500);
    return fail(unsure ? `${e.message}. Zoho may still have created it: search Zoho POs for reference ${reference} before retrying.` : e.message);
  }
}

/** Raises POs for several lines one after another (Zoho allows 100 requests a minute). */
export async function raisePos(lineIds: number[]): Promise<PoOutcome[]> {
  const out: PoOutcome[] = [];
  for (const id of lineIds) out.push(await raisePo(id));
  return out;
}

/** Lines approved with a quantity whose PO has not been raised (for the retry button). */
export async function linesAwaitingPo(runId: number): Promise<number[]> {
  const rows = await all<{ id: number }>(
    `SELECT id FROM recommendations WHERE run_id = $1 AND status = 'approved' AND final_qty > 0 AND po_ref IS NULL ORDER BY id`,
    [runId]
  );
  return rows.map((r) => r.id);
}
