// ============================================================
// Bulk Import — JSON array + Excel/xlsx file upload
// ============================================================

import { Router } from "express";
import type { TaskQueue } from "../db/task-queue.js";

interface ProductRow {
  title: string;
  priceCny: number;
  specImages: string;
  specifications?: string;
  descriptionText?: string;
}

export function createBulkRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  // POST /api/bulk/import — JSON array (existing)
  router.post("/bulk/import", async (req, res) => {
    const { products } = req.body as { products: ProductRow[] };

    if (!products || !Array.isArray(products) || products.length === 0) {
      res.status(400).json({
        success: false, error: { code: "MISSING_PRODUCTS", message: "products array required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    if (products.length > 100) {
      res.status(400).json({
        success: false, error: { code: "TOO_MANY", message: "Max 100 products per batch", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const taskIds = await enqueueProducts(products, taskQueue, req.correlationId);

    res.status(202).json({
      success: true, data: { enqueued: taskIds.length, taskIds },
      message: "Bulk import queued.",
      correlationId: req.correlationId,
    });
  });

  // POST /api/bulk/import/xlsx — Excel file upload
  router.post("/bulk/import/xlsx", async (req, res) => {
    try {
      const XLSX = await import("xlsx");

      // Accept base64-encoded xlsx in body or parse from buffer
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) {
        res.status(400).json({
          success: false, error: { code: "MISSING_FILE", message: "fileBase64 required", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      const buffer = Buffer.from(fileBase64, "base64");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

      if (!rows.length) {
        res.status(400).json({
          success: false, error: { code: "EMPTY_SHEET", message: "No data rows in file", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      if (rows.length > 100) {
        res.status(400).json({
          success: false, error: { code: "TOO_MANY", message: "Max 100 rows per file", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      // Map xlsx columns → ProductRow
      const products: ProductRow[] = rows.map((row) => ({
        title: row["标题"] || row["title"] || row["Title"] || "",
        priceCny: parseFloat(row["价格(元)"] || row["priceCny"] || row["price"] || "0"),
        specImages: row["图片URL"] || row["specImages"] || row["images"] || "",
        specifications: row["规格"] || row["specifications"] || undefined,
        descriptionText: row["描述"] || row["descriptionText"] || row["description"] || undefined,
      })).filter((p) => p.title && p.priceCny > 0);

      if (!products.length) {
        res.status(400).json({
          success: false, error: { code: "NO_VALID_ROWS", message: "No valid product rows after parsing", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      const taskIds = await enqueueProducts(products, taskQueue, req.correlationId);

      res.status(202).json({
        success: true,
        data: { enqueued: taskIds.length, totalRows: rows.length, validRows: products.length, taskIds },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "XLSX_PARSE_FAILED", message: (err as Error).message, retryable: false },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}

async function enqueueProducts(
  products: ProductRow[],
  taskQueue: TaskQueue,
  correlationId: string
): Promise<string[]> {
  const taskIds: string[] = [];
  for (const p of products) {
    // Split comma-separated image URLs
    const specImages = p.specImages
      ? p.specImages.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)
      : [] as string[];

    const specifications = p.specifications
      ? p.specifications.split(/[;；\n]+/).map((s) => s.trim()).filter(Boolean)
          .map((s) => { const [name, value] = s.split(/[:：]/); return { name: name?.trim() || "", value: value?.trim() || "" }; })
      : [] as Array<{ name: string; value: string }>;

    const queued = await taskQueue.enqueue({
      type: "batch_listing",
      payload: {
        title: p.title,
        priceCny: p.priceCny,
        specImages,
        specifications,
        descriptionText: p.descriptionText ?? p.title,
      },
      correlationId,
    });
    taskIds.push(queued.id);
  }
  return taskIds;
}
