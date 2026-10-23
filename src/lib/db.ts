import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __frPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __frSchemaReady: Promise<void> | undefined;
}

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Paste your Neon connection string into .env.local.");
  }
  if (!global.__frPool) {
    global.__frPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    // Neon can drop idle pooled connections (scale-to-zero). Without this listener the
    // dropped connection surfaces as an uncaught 'error' event and kills the process.
    global.__frPool.on("error", (err) => {
      console.error("[pg pool] idle client error (recovered):", err.message);
    });
  }
  return global.__frPool;
}

/** Runs a query, returns all rows. */
export async function all<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  const res = await getPool().query<T>(sql, params);
  return res.rows;
}

/** Runs a query, returns the first row (or undefined). */
export async function one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await all<T>(sql, params);
  return rows[0];
}

/** Runs a query for its side effect. */
export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await ensureSchema();
  await getPool().query(sql, params);
}

/** Runs fn inside a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function logAudit(event: string, detail?: unknown): Promise<void> {
  await exec(`INSERT INTO audit_log (event, detail) VALUES ($1, $2)`, [event, detail ? JSON.stringify(detail) : null]);
}

export async function closePool(): Promise<void> {
  await global.__frPool?.end();
  global.__frPool = undefined;
  global.__frSchemaReady = undefined;
}

function ensureSchema(): Promise<void> {
  if (!global.__frSchemaReady) {
    global.__frSchemaReady = getPool()
      .query(
        `
-- Master data (SAP export)
CREATE TABLE IF NOT EXISTS distributors (
  distributor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS skus (
  sku_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  perishability TEXT NOT NULL,
  standard_reorder_qty INTEGER NOT NULL,
  unit_of_measure TEXT,
  distributor_id TEXT
);

CREATE TABLE IF NOT EXISTS calendar (
  year_month TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  is_festival BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_sales (
  sku_id TEXT NOT NULL,
  week TEXT NOT NULL,
  units_sold INTEGER NOT NULL,
  PRIMARY KEY (sku_id, week)
);

CREATE TABLE IF NOT EXISTS inventory (
  sku_id TEXT NOT NULL,
  location TEXT NOT NULL,
  units_on_hand INTEGER NOT NULL,
  as_of_date DATE NOT NULL,
  PRIMARY KEY (sku_id, location)
);

-- Open purchase orders (Zoho export). Stock already on the way counts toward cover.
CREATE TABLE IF NOT EXISTS open_pos (
  po_ref TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  expected_date DATE,
  PRIMARY KEY (po_ref, sku_id)
);

-- The rubric (Raghav's forecast rules). One row, edited from the Rules page.
CREATE TABLE IF NOT EXISTS rubric (
  id INTEGER PRIMARY KEY DEFAULT 1,
  rules JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  as_of_date DATE,
  latest_week TEXT,
  festival BOOLEAN,
  model TEXT,
  summary TEXT,
  data_issues JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  sku_id TEXT NOT NULL,
  metrics JSONB NOT NULL,
  rule_flag TEXT NOT NULL,
  rule_action TEXT NOT NULL,
  ai_flag TEXT,
  ai_high_demand BOOLEAN,
  ai_action TEXT,
  ai_reason TEXT,
  recommended_qty INTEGER NOT NULL DEFAULT 0,
  is_exception BOOLEAN NOT NULL DEFAULT false,
  exception_reasons JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  final_qty INTEGER,
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  po_ref TEXT,
  po_placed_at TIMESTAMPTZ,
  UNIQUE (run_id, sku_id)
);

-- Zoho purchase order raised from an approved line.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS zoho_status TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS zoho_po_id TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS zoho_reference TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS zoho_error TEXT;

-- SKU -> Zoho item, Distributor -> Zoho vendor.
CREATE TABLE IF NOT EXISTS zoho_map (
  kind TEXT NOT NULL CHECK (kind IN ('item', 'vendor')),
  local_id TEXT NOT NULL,
  zoho_id TEXT NOT NULL,
  zoho_name TEXT,
  purchase_rate DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, local_id)
);

CREATE TABLE IF NOT EXISTS stockout_reports (
  id SERIAL PRIMARY KEY,
  sku_id TEXT NOT NULL,
  note TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`
      )
      .then(() => undefined)
      .catch((err) => {
        global.__frSchemaReady = undefined;
        throw err;
      });
  }
  return global.__frSchemaReady;
}
