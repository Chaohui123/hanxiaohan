// ============================================================
// DB model operations — thin wrappers over SQL queries
// ============================================================

import { getDb, serializedWrite } from "./connection.js";

export interface FailedTask {
  id: string;
  storeId: string;
  taskType: string;
  payloadJson: string;
  errorMessage: string;
  status: "pending_retry" | "retrying" | "failed" | "retried";
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
}

export interface ListingRecord {
  id: string;
  sourceUrl: string;
  status: string;
  draftId?: string;
  ozonProductId?: number;
  correlationId: string;
  resultJson?: string;
  createdAt: string;
}

export interface PriceRecord {
  id: number;
  productSku: string;
  platform: string;
  priceRub: number;
  sourceUrl: string;
  capturedAt: string;
}

export interface StoreConfig {
  storeId: string;
  clientId: string;
  apiKey: string;
  storeName?: string;
  proxyUrl?: string;
  active: number;
}

// ---- Failed Tasks ----

export async function saveFailedTask(task: Omit<FailedTask, "createdAt" | "updatedAt" | "retryCount">): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await serializedWrite(() =>
    db.run(
      `INSERT INTO failed_tasks (id, store_id, task_type, payload_json, error_message, status, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, draft_id=EXCLUDED.draft_id, ozon_product_id=EXCLUDED.ozon_product_id, result_json=EXCLUDED.result_json ON CONFLICT(id) DO UPDATE SET error_message=EXCLUDED.error_message, status=EXCLUDED.status`,
      [task.id, task.storeId, task.taskType, task.payloadJson, task.errorMessage, task.status, task.correlationId]
    )
  );
}

export async function getFailedTasks(storeId: string, limit = 50): Promise<FailedTask[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db.all(
    "SELECT * FROM failed_tasks WHERE store_id = ? ORDER BY created_at DESC LIMIT ?",
    [storeId, limit]
  ) as Record<string, unknown>[];

  return rows.map(rowToFailedTask);
}

export async function updateFailedTaskStatus(taskId: string, updates: {
  status?: FailedTask["status"];
  retryCount?: number;
  errorMessage?: string | null;
  storeId?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.retryCount !== undefined) {
    fields.push("retry_count = ?");
    values.push(updates.retryCount);
  }
  if (updates.errorMessage !== undefined) {
    fields.push("error_message = ?");
    values.push(updates.errorMessage);
  }
  if (updates.storeId !== undefined) {
    fields.push("store_id = ?");
    values.push(updates.storeId);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = NOW()");
  values.push(taskId);

  await serializedWrite(() =>
    db.run(`UPDATE failed_tasks SET ${fields.join(", ")} WHERE id = ?`, values)
  );
}

// ---- Listing Records ----

export async function saveListingRecord(record: Omit<ListingRecord, "createdAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await serializedWrite(() =>
    db.run(
      `INSERT INTO listing_records (id, source_url, status, draft_id, ozon_product_id, correlation_id, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, draft_id=EXCLUDED.draft_id, ozon_product_id=EXCLUDED.ozon_product_id, result_json=EXCLUDED.result_json ON CONFLICT(id) DO UPDATE SET error_message=EXCLUDED.error_message, status=EXCLUDED.status`,
      [record.id, record.sourceUrl, record.status, record.draftId ?? null, record.ozonProductId ?? null, record.correlationId, record.resultJson ?? null]
    )
  );
}

export async function getListingRecords(limit = 20): Promise<ListingRecord[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db.all(
    "SELECT * FROM listing_records ORDER BY created_at DESC LIMIT ?",
    [limit]
  ) as Record<string, unknown>[];

  return rows.map(rowToListingRecord);
}

// ---- Price History ----

export async function savePriceRecord(record: Omit<PriceRecord, "id" | "capturedAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await serializedWrite(() =>
    db.run(
      "INSERT INTO price_history (product_sku, platform, price_rub, source_url) VALUES (?, ?, ?, ?)",
      [record.productSku, record.platform, record.priceRub, record.sourceUrl]
    )
  );
}

export async function getPriceHistory(productSku: string, platform?: string, limit = 30): Promise<PriceRecord[]> {
  const db = await getDb();
  if (!db) return [];

  const platformFilter = platform ? "AND platform = ?" : "";
  const params = platform ? [productSku, platform, limit] : [productSku, limit];

  return db.all(
    `SELECT * FROM price_history WHERE product_sku = ? ${platformFilter} ORDER BY captured_at DESC LIMIT ?`,
    ...params
  ) as Promise<PriceRecord[]>;
}

// ---- Store Configs ----

export async function getStoreConfigs(): Promise<StoreConfig[]> {
  const db = await getDb();
  if (!db) return [];

  return db.all("SELECT * FROM store_configs WHERE active = 1") as Promise<StoreConfig[]>;
}

export async function upsertStoreConfig(config: Omit<StoreConfig, "active">): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await serializedWrite(() =>
    db.run(
      `INSERT INTO store_configs (store_id, client_id, api_key, store_name, proxy_url)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET client_id=EXCLUDED.client_id, api_key=EXCLUDED.api_key, store_name=EXCLUDED.store_name, proxy_url=EXCLUDED.proxy_url`,
      [config.storeId, config.clientId, config.apiKey, config.storeName ?? null, config.proxyUrl ?? null]
    )
  );
}

// ---- Row mappers ----

type DbRow = Record<string, unknown>;

function rowToFailedTask(row: DbRow): FailedTask {
  return {
    id: row.id as string,
    storeId: row.store_id as string,
    taskType: row.task_type as string,
    payloadJson: row.payload_json as string,
    errorMessage: row.error_message as string,
    status: row.status as FailedTask["status"],
    correlationId: row.correlation_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    retryCount: row.retry_count as number,
  };
}

function rowToListingRecord(row: DbRow): ListingRecord {
  return {
    id: row.id as string,
    sourceUrl: row.source_url as string,
    status: row.status as string,
    draftId: row.draft_id as string | undefined,
    ozonProductId: row.ozon_product_id as number | undefined,
    correlationId: row.correlation_id as string,
    resultJson: row.result_json as string | undefined,
    createdAt: row.created_at as string,
  };
}
