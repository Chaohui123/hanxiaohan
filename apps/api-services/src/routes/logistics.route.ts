// ============================================================
// Logistics Routes — freight forwarder tracking + diagnose + webhook
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { FreightForwarderService } from "../services/freight-forwarder.js";
import { LogisticsOrchestrator } from "../services/logistics-orchestrator.js";
import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

export function createLogisticsRouter(ozonClient: OzonClient): Router {
  const router = Router();

  /** POST /api/logistics/tracking — freight forwarder submits international tracking number */
  router.post("/logistics/tracking", async (req, res) => {
    try {
      const { postingNumber, trackingNumber, carrier, weightGrams, notes } = req.body as Record<string, unknown>;
      if (!postingNumber || !trackingNumber) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "postingNumber and trackingNumber required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const service = new FreightForwarderService(db);
      const result = await service.ingestTracking(ozonClient, {
        postingNumber: postingNumber as string,
        trackingNumber: trackingNumber as string,
        carrier: carrier as string,
        weightGrams: weightGrams as number,
        notes: notes as string,
      });

      res.json({ success: result.success, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TRACKING_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/tracking/batch — batch ingestion */
  router.post("/logistics/tracking/batch", async (req, res) => {
    try {
      const { items } = req.body as { items: Array<Record<string, unknown>> };
      if (!items || !Array.isArray(items) || items.length === 0) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "items array required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const service = new FreightForwarderService(db);
      const results = await service.ingestBatch(ozonClient, items.map((i) => ({
        postingNumber: i.postingNumber as string,
        trackingNumber: i.trackingNumber as string,
        carrier: i.carrier as string,
        weightGrams: i.weightGrams as number,
      })));

      res.json({ success: true, data: { total: results.length, succeeded: results.filter((r) => r.success).length, results } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BATCH_TRACKING_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/logistics/delays — check for logistics delays (48h no tracking) */
  router.get("/logistics/delays", async (_req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const service = new FreightForwarderService(db);
      const alerts = await service.checkLogisticsDelays();
      res.json({ success: true, data: alerts, count: alerts.length });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DELAY_ERROR", message: (err as Error).message } });
    }
  });

  // ==============================================================
  // New endpoints (LOGISTICS_ENABLE feature flag)
  // ==============================================================

  const logisticsEnabled = process.env.LOGISTICS_ENABLE === "true";

  /** POST /api/logistics/shipment — auto-create shipment from 1688 purchase (protected by Redis lock) */
  router.post("/logistics/shipment", async (req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const body = req.body as Record<string, unknown>;
      if (!body.postingNumber) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "postingNumber required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      const result = await orchestrator.createShipment({
        postingNumber: body.postingNumber as string,
        purchaseId: body.purchaseId as string || body.postingNumber as string,
        storeId: body.storeId as string,
        deliveryType: (body.deliveryType as "courier" | "pickup") || "courier",
      });

      res.json({ success: result.success, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SHIPMENT_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/shipment/batch — batch create for all pending purchases */
  router.post("/logistics/shipment/batch", async (_req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      const result = await orchestrator.batchCreateShipments(ozonClient);

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BATCH_SHIPMENT_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/webhook/cdek — CDEK tracking webhook receiver */
  router.post("/logistics/webhook/cdek", async (req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const payload = req.body as Record<string, unknown>;

      // CDEK webhook format: { type: "ORDER_STATUS", date_time, uuid, attributes: { cdek_number, status, ... } }
      const attributes = (payload.attributes || payload) as Record<string, unknown>;
      const trackingNumber = (attributes.cdek_number || attributes.track || attributes.tracking_number) as string | undefined;
      const status = (attributes.status || payload.status || payload.type) as string | undefined;
      const statusDescription = (attributes.status_description || attributes.statusDescription || status) as string | undefined;

      if (!trackingNumber || !status) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "trackingNumber and status required in webhook payload" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      await orchestrator.processWebhook({
        trackingNumber,
        status,
        statusDescription: statusDescription || status,
        timestamp: (payload.date_time || new Date().toISOString()) as string,
        location: (attributes.location || attributes.city) as string,
        carrier: "cdek",
      });

      res.json({ success: true, correlationId: req.correlationId });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "CDEK webhook processing failed");
      // Always return 200 for webhooks — caller shouldn't retry on error
      res.json({ success: false, error: { code: "WEBHOOK_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/webhook/boxberry — Boxberry tracking webhook receiver */
  router.post("/logistics/webhook/boxberry", async (req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const payload = req.body as Record<string, unknown>;

      const trackingNumber = (payload.track || payload.tracking_number) as string | undefined;
      const status = (payload.status || payload.status_text) as string | undefined;

      if (!trackingNumber || !status) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "track and status required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      await orchestrator.processWebhook({
        trackingNumber,
        status,
        statusDescription: (payload.status_text || status) as string,
        timestamp: (payload.date || new Date().toISOString()) as string,
        location: (payload.city) as string,
        carrier: "boxberry",
      });

      res.json({ success: true, correlationId: req.correlationId });
    } catch (err) {
      res.json({ success: false, error: { code: "WEBHOOK_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/logistics/diagnose — comprehensive logistics diagnostic */
  router.get("/logistics/diagnose", async (_req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      const diagnose = await orchestrator.diagnose();

      res.json({ success: true, data: diagnose });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DIAGNOSE_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/delays/check — manual trigger for delay check + TG alerts */
  router.post("/logistics/delays/check", async (_req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      const alertCount = await orchestrator.checkDelays();

      res.json({ success: true, data: { alertsFired: alertCount } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DELAY_CHECK_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/cost/writeback — force cost writeback for a posting */
  router.post("/logistics/cost/writeback", async (req, res) => {
    if (!logisticsEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set LOGISTICS_ENABLE=true to enable" } });
      return;
    }
    try {
      const { postingNumber } = req.body as { postingNumber?: string };
      if (!postingNumber) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "postingNumber required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const orchestrator = new LogisticsOrchestrator(db);
      await orchestrator.writeLogisticsCost(postingNumber);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "COST_WRITEBACK_ERROR", message: (err as Error).message } });
    }
  });

  // ==============================================================
  // Transition logistics (TRANSITION_LOGISTICS=kuajingbus)
  // Semi-auto workflow: export to xlsx → send to freight forwarder → import tracking
  // ==============================================================

  const transitionEnabled = process.env.TRANSITION_LOGISTICS === "kuajingbus";

  /** POST /api/logistics/import — import tracking xlsx from 跨境巴士, backfill to Ozon */
  router.post("/logistics/import", async (req, res) => {
    if (!transitionEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set TRANSITION_LOGISTICS=kuajingbus to enable" } });
      return;
    }
    try {
      const body = req.body as { fileBase64?: string; rows?: Record<string, string>[] };
      let rows: Record<string, string>[] = [];

      if (body.fileBase64) {
        // Parse xlsx from base64
        try {
          const XLSX = await import("xlsx");
          const buffer = Buffer.from(body.fileBase64, "base64");
          const wb = XLSX.read(buffer, { type: "buffer" });
          const sheetName = wb.SheetNames[0] || "Sheet1";
          rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[sheetName]!);
        } catch {
          res.status(400).json({ success: false, error: { code: "PARSE_ERROR", message: "Failed to parse xlsx file" } });
          return;
        }
      } else if (body.rows) {
        rows = body.rows;
      } else {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "fileBase64 or rows array required" } });
        return;
      }

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: { code: "EMPTY", message: "No data rows in file" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      const result = await service.importTracking(rows, ozonClient);

      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "IMPORT_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/billing — import freight forwarder billing xlsx, calculate profit */
  router.post("/logistics/billing", async (req, res) => {
    if (!transitionEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set TRANSITION_LOGISTICS=kuajingbus to enable" } });
      return;
    }
    try {
      const body = req.body as { fileBase64?: string; rows?: Record<string, string>[] };
      let rows: Record<string, string>[] = [];

      if (body.fileBase64) {
        try {
          const XLSX = await import("xlsx");
          const buffer = Buffer.from(body.fileBase64, "base64");
          const wb = XLSX.read(buffer, { type: "buffer" });
          const sheetName = wb.SheetNames[0] || "Sheet1";
          rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[sheetName]!);
        } catch {
          res.status(400).json({ success: false, error: { code: "PARSE_ERROR", message: "Failed to parse xlsx file" } });
          return;
        }
      } else if (body.rows) {
        rows = body.rows;
      } else {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "fileBase64 or rows array required" } });
        return;
      }

      const db = await getDb().catch(() => null);
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      const result = await service.importBilling(rows);

      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BILLING_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/logistics/dashboard — transition logistics status overview */
  router.get("/logistics/dashboard", async (_req, res) => {
    if (!transitionEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set TRANSITION_LOGISTICS=kuajingbus to enable" } });
      return;
    }
    try {
      const db = await getDb().catch(() => null);
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      const dashboard = await service.getDashboard();

      res.json({ success: true, data: dashboard });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DASHBOARD_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/check-overdue — manual trigger overdue alerts */
  router.post("/logistics/check-overdue", async (_req, res) => {
    if (!transitionEnabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set TRANSITION_LOGISTICS=kuajingbus to enable" } });
      return;
    }
    try {
      const db = await getDb().catch(() => null);
      const { TransitionLogisticsService } = await import("../services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      const [count24h, count48h] = await Promise.all([
        service.check24hOverdue(),
        service.check48hOverdue(),
      ]);

      res.json({ success: true, data: { alerts24h: count24h, alerts48h: count48h } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "CHECK_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/logistics/export-kuajingbus — export selected purchases to 跨境巴士 template */
  router.post("/logistics/export-kuajingbus", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" } });

      const { ids } = (req.body || {}) as { ids?: string[] };
      if (!ids || ids.length === 0) {
        return res.status(400).json({ success: false, error: { code: "MISSING", message: "请在请求中提供要导出的采购单ID列表 ids: [...]" } });
      }

      // Fetch selected purchases
      const placeholders = ids.map(() => "?").join(",");
      const purchases = await db.all<Record<string, string>>(
        `SELECT id, ozon_posting_number, logistics_tracking,
                sku_list_json
         FROM purchase_1688
         WHERE id IN (${placeholders})
         ORDER BY created_at DESC`,
        ids
      );

      if (purchases.length === 0) {
        return res.json({ success: true, data: { count: 0, message: "未找到指定的采购单" } });
      }

      // Get SKU weights
      const skuRows = await db.all<{ ozon_posting_number: string; weight_kg: number }>(
        `SELECT DISTINCT ozon_offer_id, weight_kg FROM sku_1688_mapping`
      ).catch(() => []);
      const weightMap = new Map<string, number>();
      for (const s of skuRows) weightMap.set(s.ozon_posting_number, s.weight_kg || 0.3);

      // Load original template from repo assets
      const XLSX = await import("xlsx");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const templatePath = join(process.cwd(), "assets", "kuajingbus-template.xlsx");
      const templateBuf = readFileSync(templatePath);
      const wb = XLSX.read(templateBuf, { type: "buffer" });

      // Add data rows to "基础信息" sheet (first sheet), keeping all instruction rows
      const ws = wb.Sheets[wb.SheetNames[0]!];
      if (!ws) throw new Error("Template missing 基础信息 sheet");

      // Find the row after "请在此行开始填写真实订单" to start appending data
      let startRow = 6; // default: known position in template
      const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
      for (let r = 1; r <= range.e.r; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        if (cell && typeof cell.v === "string" && cell.v.includes("请在此行开始填写真实订单")) {
          startRow = r + 1;
          break;
        }
      }

      // Build rows from purchase data
      let rowIdx = startRow;
      for (const p of purchases) {
        const skus = JSON.parse(p.sku_list_json || "[]") as Array<{ sku: number; quantity: number; unitPriceCny: number }>;
        if (skus.length === 0) continue;

        const totalQty = skus.reduce((s, sk) => s + sk.quantity, 0);
        const weight = weightMap.get(p.ozon_posting_number) || "";

        const data = [
          "",                              // A 注释
          "1052",                          // B 仓库代码
          "10",                            // C 服务代码
          p.ozon_posting_number,           // D 电商平台订单号
          p.logistics_tracking || "",      // E 面单条形码
          "",                              // F 产品图片 — 人工
          "",                              // G 产品名称 — 非必填
          String(totalQty),                // H 产品数量
          "1688",                          // I 打包来源
          "",                              // J 快递单号/SKUID — 人工
          weight ? String(weight) : "",    // K 预估重量(kg)
          "1688",                          // L 采购平台
          p.id,                            // M 采购单号
        ];

        for (let c = 0; c < data.length; c++) {
          const cell = XLSX.utils.encode_cell({ r: rowIdx, c });
          ws[cell] = { t: "s", v: data[c] };
        }
        rowIdx++;
      }

      // Update sheet range
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rowIdx - 1, c: 12 } });

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const filename = `跨境巴士_${new Date().toISOString().slice(0, 10)}.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=${encodeURIComponent(filename)}`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "EXPORT_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}
