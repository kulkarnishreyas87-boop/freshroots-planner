import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPurchaseOrder, findItemBySku, zohoMissing } from "./zoho";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
let replies: ((c: Call) => Response)[] = [];

beforeEach(() => {
  Object.assign(process.env, {
    ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "secret", ZOHO_REFRESH_TOKEN: "rt", ZOHO_ORGANIZATION_ID: "60001",
    ZOHO_ACCOUNTS_URL: "https://accounts.zoho.in", ZOHO_API_BASE: "https://www.zohoapis.in/inventory/v1/",
  });
  global.__zohoToken = undefined;
  calls = [];
  replies = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(c);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected call ${c.url}`);
    return next(c);
  }) as typeof fetch;
});

const json = (status: number, raw: string) => () => new Response(raw, { status, headers: { "Content-Type": "application/json" } });
const token = json(200, `{"access_token":"at-1","expires_in":3600}`);

test("reports which settings are missing", () => {
  delete process.env.ZOHO_REFRESH_TOKEN;
  assert.deepEqual(zohoMissing(), ["ZOHO_REFRESH_TOKEN"]);
});

test("creates a PO: refreshes the token once, keeps 19-digit ids exact, sends ids as integers", async () => {
  replies.push(token, json(201, `{"code":0,"message":"success","purchase_order":{"purchaseorder_id":4815000000044972123,"purchaseorder_number":"PO-00031","status":"draft"}}`));
  const po = await createPurchaseOrder({ vendorId: "4815000000044080999", itemId: "4815000000044100777", quantity: 150, purchaseRate: 42.5, date: "2026-10-22", reference: "FR-R1-SKU004-L5", notes: "n" });
  assert.equal(po.purchaseorder_id, "4815000000044972123");
  assert.equal(po.purchaseorder_number, "PO-00031");

  assert.match(calls[0].url, /^https:\/\/accounts\.zoho\.in\/oauth\/v2\/token\?/);
  assert.match(calls[0].url, /grant_type=refresh_token/);
  assert.equal(calls[1].url, "https://www.zohoapis.in/inventory/v1/purchaseorders?organization_id=60001");
  assert.equal(calls[1].headers.Authorization, "Zoho-oauthtoken at-1");
  assert.match(calls[1].body!, /"vendor_id":4815000000044080999,/);
  assert.match(calls[1].body!, /"item_id":4815000000044100777,"quantity":150,"purchase_rate":42.5/);
  const parsed = JSON.parse(calls[1].body!);
  assert.equal(parsed.reference_number, "FR-R1-SKU004-L5");

  // second call reuses the cached token
  replies.push(json(201, `{"code":0,"purchase_order":{"purchaseorder_id":1234567890123,"purchaseorder_number":"PO-00032"}}`));
  await createPurchaseOrder({ vendorId: "1", itemId: "2", quantity: 1, purchaseRate: null, date: "2026-10-22", reference: "r", notes: "" });
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[2].body!, /purchase_rate/);
});

test("Zoho error codes become readable errors", async () => {
  replies.push(token, json(400, `{"code":1004,"message":"Vendor does not exist."}`));
  await assert.rejects(
    createPurchaseOrder({ vendorId: "1", itemId: "2", quantity: 1, purchaseRate: null, date: "2026-10-22", reference: "r", notes: "" }),
    /Zoho error 1004 \(HTTP 400\): Vendor does not exist\./
  );
});

test("failed sign-in explains what to check", async () => {
  replies.push(json(200, `{"error":"invalid_code"}`));
  await assert.rejects(findItemBySku("SKU001"), /Zoho sign-in failed: invalid_code/);
});

test("item lookup needs an exact SKU match", async () => {
  replies.push(token, json(200, `{"code":0,"items":[{"item_id":4815000000044100777,"sku":"SKU0011","name":"Other"},{"item_id":4815000000044100778,"sku":"SKU001","name":"Mango Drink","purchase_rate":18}]}`));
  const item = await findItemBySku("SKU001");
  assert.deepEqual(item, { item_id: "4815000000044100778", sku: "SKU001", name: "Mango Drink", purchase_rate: 18 });
  assert.match(calls[1].url, /\/items\?organization_id=60001&sku=SKU001$/);
});

test("rejects ids that are not Zoho ids before calling Zoho", async () => {
  await assert.rejects(
    createPurchaseOrder({ vendorId: "abc", itemId: "2", quantity: 1, purchaseRate: null, date: "2026-10-22", reference: "r", notes: "" }),
    /not a Zoho id/
  );
  assert.equal(calls.length, 0);
});
