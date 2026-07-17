// ============================================================
// Export routes — CSV/XLSX data export for orders, inventory, sales, finance
// + Transition logistics order export for 跨境巴士 template
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { TransitionLogisticsService } from "../services/transition-logistics.js";

export function createExportRouter(): Router {
  const router = Router();

  // GET /api/export/orders
  router.get("/export/orders", async (req, res) => {
    const { from, to, format = "csv" } = req.query as { from?: string; to?: string; format?: string };
    const db = await getDb().catch(() => null);
    if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }

    const rows = await db.all(
      "SELECT * FROM local_orders WHERE created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 10000",
      [from || "2020-01-01", to || "2099-12-31"]
    ) as Array<Record<string, unknown>>;

    sendResponse(res, rows, `orders-${from || "all"}-${to || "all"}`, format as string);
  });

  // GET /api/order/export — transition logistics order export (跨境巴士 template)
  router.get("/order/export", async (req, res) => {
    const db = await getDb().catch(() => null);
    if (!db) { res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" } }); return; }

    const service = new TransitionLogisticsService(db);
    if (!service.enabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set TRANSITION_LOGISTICS=kuajingbus to enable" } });
      return;
    }

    try {
      const exportData = await service.generateExport();

      if (exportData.rows.length === 0) {
        res.json({ success: true, data: { count: 0, message: "没有待导出的订单" }, correlationId: req.correlationId });
        return;
      }

      const format = (req.query.format as string) || "xlsx";

      if (format === "csv") {
        sendCsvWithHeaders(res, exportData.headers, exportData.rows, exportData.filename.replace(".xlsx", ".csv"));
      } else {
        // xlsx export
        try {
          const XLSX = await import("xlsx");
          const data = exportData.rows.map((r) => {
            const obj: Record<string, string> = {};
            for (const h of exportData.headers) obj[h] = r[h] ?? "";
            return obj;
          });
          const ws = XLSX.utils.json_to_sheet(data);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "待预报订单");
          const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

          res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          res.setHeader("Content-Disposition", `attachment; filename=${encodeURIComponent(exportData.filename)}`);
          res.send(buf);
        } catch {
          sendCsvWithHeaders(res, exportData.headers, exportData.rows, exportData.filename.replace(".xlsx", ".csv"));
        }
      }
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "EXPORT_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // GET /api/export/inventory
  router.get("/export/inventory", async (req, res) => {
    const { format = "csv" } = req.query as { format?: string };
    const db = await getDb().catch(() => null);
    if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }

    const rows = await db.all("SELECT * FROM inventory ORDER BY offer_id, sku LIMIT 10000") as Array<Record<string, unknown>>;
    sendResponse(res, rows, "inventory-snapshot", format as string);
  });

  // GET /api/export/sales
  router.get("/export/sales", async (req, res) => {
    const { from, to, format = "csv" } = req.query as { from?: string; to?: string; format?: string };
    const db = await getDb().catch(() => null);
    if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }

    const rows = await db.all(
      "SELECT * FROM daily_sales WHERE date >= ? AND date <= ? ORDER BY date LIMIT 10000",
      [from || "2020-01-01", to || "2099-12-31"]
    ) as Array<Record<string, unknown>>;

    sendResponse(res, rows, `sales-${from || "all"}-${to || "all"}`, format as string);
  });

  // GET /api/export/finance
  router.get("/export/finance", async (req, res) => {
    const { from, to, format = "csv" } = req.query as { from?: string; to?: string; format?: string };
    const db = await getDb().catch(() => null);
    if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }

    const rows = await db.all(
      "SELECT posting_number, order_id, status, total_price_rub, commission_rub, payout_rub, created_at FROM local_orders WHERE created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 10000",
      [from || "2020-01-01", to || "2099-12-31"]
    ) as Array<Record<string, unknown>>;

    sendResponse(res, rows, `finance-${from || "all"}-${to || "all"}`, format as string);
  });

  return router;
}

// ---- Helpers ----

function sendCsvWithHeaders(
  res: import("express").Response,
  headers: string[],
  rows: Record<string, string>[],
  filename: string,
): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.write("﻿"); // BOM for Excel UTF-8

  res.write(headers.map((h) => csvEscape(h)).join(",") + "\n");
  for (const row of rows) {
    res.write(headers.map((h) => csvEscape(row[h] ?? "")).join(",") + "\n");
  }
  res.end();
}

function sendResponse(
  res: import("express").Response,
  rows: Array<Record<string, unknown>>,
  filename: string,
  format: string
): void {
  if (format === "xlsx") {
    sendXlsx(res, rows, filename);
  } else {
    sendCsv(res, rows, filename);
  }
}

function sendCsv(res: import("express").Response, rows: Array<Record<string, unknown>>, filename: string): void {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  sendCsvWithHeaders(res, headers, rows as Record<string, string>[], `${filename}.csv`);
}

async function sendXlsx(res: import("express").Response, rows: Array<Record<string, unknown>>, filename: string): Promise<void> {
  if (rows.length === 0) {
    sendCsv(res, rows, filename);
    return;
  }

  try {
    const XLSX = await import("xlsx");
    const headers = Object.keys(rows[0]);
    const data = rows.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const h of headers) obj[h] = r[h];
      return obj;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}.xlsx`);
    res.send(buf);
  } catch {
    // xlsx not installed — fallback to CSV
    sendCsv(res, rows, filename);
  }
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
