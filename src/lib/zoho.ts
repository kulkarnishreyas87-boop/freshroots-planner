/**
 * Zoho Inventory API client: OAuth token refresh, item and vendor lookup, purchase orders.
 * Endpoints and fields follow https://www.zoho.com/inventory/api/v1/ (purchaseorders, items,
 * contacts, oauth). Zoho ids are large integers, so they are kept as strings end to end.
 */

declare global {
  // eslint-disable-next-line no-var
  var __zohoToken: { token: string; expiresAt: number } | undefined;
}

const REQUIRED = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORGANIZATION_ID", "ZOHO_ACCOUNTS_URL", "ZOHO_API_BASE"] as const;

export function zohoMissing(): string[] {
  return REQUIRED.filter((k) => !process.env[k]?.trim());
}

export function zohoConfigured(): boolean {
  return zohoMissing().length === 0;
}

function env(k: (typeof REQUIRED)[number]): string {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in .env.local.`);
  return v.replace(/\/+$/, "");
}

export class ZohoError extends Error {
  constructor(message: string, public status?: number, public code?: number) {
    super(message);
  }
}

/** Parses Zoho JSON keeping every *_id number (they exceed JS's safe integer range) as a string. */
function parseZoho(text: string): Record<string, unknown> {
  const safe = text.replace(/"(\w*_id)"\s*:\s*(-?\d{10,})/g, '"$1":"$2"');
  return JSON.parse(safe);
}

async function accessToken(): Promise<string> {
  const cached = global.__zohoToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const params = new URLSearchParams({
    refresh_token: env("ZOHO_REFRESH_TOKEN"),
    client_id: env("ZOHO_CLIENT_ID"),
    client_secret: env("ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });
  if (process.env.ZOHO_REDIRECT_URI?.trim()) params.set("redirect_uri", process.env.ZOHO_REDIRECT_URI.trim());

  const res = await fetch(`${env("ZOHO_ACCOUNTS_URL")}/oauth/v2/token?${params}`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    throw new ZohoError(`Zoho sign-in failed${json.error ? `: ${json.error}` : ` (HTTP ${res.status})`}. Check the client id, secret, refresh token and accounts URL for your data centre.`, res.status);
  }
  global.__zohoToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: string } = {}) {
  const q = new URLSearchParams({ organization_id: env("ZOHO_ORGANIZATION_ID"), ...(opts.query ?? {}) });
  const res = await fetch(`${env("ZOHO_API_BASE")}${path}?${q}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${await accessToken()}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = parseZoho(text);
  } catch {
    throw new ZohoError(`Zoho returned a non-JSON reply (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
    if (res.status === 401) global.__zohoToken = undefined;
    throw new ZohoError(`Zoho error${json.code !== undefined ? ` ${json.code}` : ""} (HTTP ${res.status}): ${String(json.message ?? "no message")}`, res.status, json.code as number);
  }
  return json;
}

export interface ZohoItem { item_id: string; sku: string; name: string; purchase_rate: number | null }
export interface ZohoVendor { contact_id: string; contact_name: string; company_name: string }

/** Exact-SKU lookup. Returns null when Zoho has no item with that SKU. */
export async function findItemBySku(sku: string): Promise<ZohoItem | null> {
  const json = await call("GET", "/items", { query: { sku } });
  const items = (json.items as ZohoItem[] | undefined) ?? [];
  const hit = items.find((i) => i.sku === sku);
  return hit ? { item_id: String(hit.item_id), sku: hit.sku, name: hit.name, purchase_rate: typeof hit.purchase_rate === "number" ? hit.purchase_rate : null } : null;
}

export async function listVendors(): Promise<ZohoVendor[]> {
  const out: ZohoVendor[] = [];
  for (let page = 1; page <= 10; page++) {
    const json = await call("GET", "/contacts", { query: { contact_type: "vendor", page: String(page), per_page: "200" } });
    const rows = (json.contacts as ZohoVendor[] | undefined) ?? [];
    out.push(...rows.map((c) => ({ contact_id: String(c.contact_id), contact_name: c.contact_name, company_name: c.company_name })));
    const more = (json.page_context as { has_more_page?: boolean } | undefined)?.has_more_page;
    if (!more || rows.length === 0) break;
  }
  return out;
}

export interface CreatedPo { purchaseorder_id: string; purchaseorder_number: string; status: string }

/**
 * Creates one purchase order. Zoho's own numbering assigns the PO number.
 * reference_number carries our line reference so a PO can be traced back to the approval.
 */
export async function createPurchaseOrder(p: {
  vendorId: string;
  itemId: string;
  quantity: number;
  purchaseRate: number | null;
  date: string; // YYYY-MM-DD
  reference: string;
  notes: string;
}): Promise<CreatedPo> {
  if (!/^\d+$/.test(p.vendorId) || !/^\d+$/.test(p.itemId)) throw new ZohoError("Vendor or item id is not a Zoho id.");
  // Ids go out as JSON integers, written as raw digits so no precision is lost.
  const lineRate = p.purchaseRate !== null ? `,"purchase_rate":${JSON.stringify(p.purchaseRate)}` : "";
  const body =
    `{"vendor_id":${p.vendorId},"date":${JSON.stringify(p.date)},"reference_number":${JSON.stringify(p.reference)},` +
    `"notes":${JSON.stringify(p.notes)},"line_items":[{"item_id":${p.itemId},"quantity":${p.quantity}${lineRate}}]}`;
  const json = await call("POST", "/purchaseorders", { body });
  const po = json.purchase_order as { purchaseorder_id?: string; purchaseorder_number?: string; status?: string } | undefined;
  if (!po?.purchaseorder_id) throw new ZohoError("Zoho accepted the request but returned no purchase order id.");
  return { purchaseorder_id: String(po.purchaseorder_id), purchaseorder_number: String(po.purchaseorder_number ?? ""), status: String(po.status ?? "") };
}

export async function markIssued(purchaseorderId: string): Promise<void> {
  await call("POST", `/purchaseorders/${purchaseorderId}/status/issued`);
}

/** Cheap check used by the Zoho page: can we sign in and reach the organisation? */
export async function ping(): Promise<void> {
  await call("GET", "/items", { query: { per_page: "1" } });
}
