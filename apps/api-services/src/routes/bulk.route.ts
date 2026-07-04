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

  // POST /api/bulk/import/csv — CSV text or file upload
  router.post("/bulk/import/csv", async (req, res) => {
    try {
      const { csvText, fileBase64 } = req.body as { csvText?: string; fileBase64?: string };

      let raw: string;
      if (fileBase64) {
        raw = Buffer.from(fileBase64, "base64").toString("utf-8");
      } else if (csvText) {
        // Handle both literal \n and actual newlines
        raw = csvText.replace(/\\n/g, "\n");
      } else {
        res.status(400).json({
          success: false, error: { code: "MISSING_DATA", message: "csvText or fileBase64 required", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      // Parse CSV (simple line-by-line, handles quoted fields)
      const lines = raw.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        res.status(400).json({
          success: false, error: { code: "EMPTY_CSV", message: "CSV must have header + at least 1 data row", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      const headers = parseCSVLine(lines[0]);
      const titleIdx = headers.findIndex((h) => ["标题","title","Title","商品名称"].includes(h));
      const priceIdx = headers.findIndex((h) => ["价格(元)","priceCny","price","价格"].includes(h));
      const imagesIdx = headers.findIndex((h) => ["图片URL","specImages","images","图片"].includes(h));
      const specsIdx = headers.findIndex((h) => ["规格","specifications","specs"].includes(h));
      const descIdx = headers.findIndex((h) => ["描述","descriptionText","description","描述"].includes(h));

      if (titleIdx < 0 || priceIdx < 0) {
        res.status(400).json({
          success: false, error: { code: "MISSING_COLUMNS", message: "CSV must have 标题 + 价格(元) columns", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      const products: Array<{ title: string; priceCny: number; specImages: string[]; specifications?: Array<{ name: string; value: string }>; descriptionText?: string }> = [];

      for (let i = 1; i < lines.length && products.length < 100; i++) {
        const cols = parseCSVLine(lines[i]);
        const title = cols[titleIdx]?.trim();
        const price = parseFloat(cols[priceIdx] || "0");
        if (!title || price <= 0) continue;

        const images = imagesIdx >= 0 ? cols[imagesIdx]?.split(/[,;\s]+/).filter(Boolean) || [] : [];

        let specs: Array<{ name: string; value: string }> = [];
        if (specsIdx >= 0 && cols[specsIdx]) {
          specs = cols[specsIdx].split(/[;；]/).filter(Boolean).map((s) => {
            const [n, v] = s.split(/[:：]/);
            return { name: n?.trim() || "", value: v?.trim() || "" };
          });
        }

        products.push({
          title,
          priceCny: price,
          specImages: images as string[],
          specifications: specs,
          descriptionText: descIdx >= 0 ? cols[descIdx]?.trim() : title,
        });
      }

      if (!products.length) {
        res.status(400).json({
          success: false, error: { code: "NO_VALID_ROWS", message: "No valid products after CSV parsing", retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      const taskIds = await enqueueProducts(products, taskQueue, req.correlationId);

      res.status(202).json({
        success: true,
        data: { enqueued: taskIds.length, totalRows: lines.length - 1, validRows: products.length, taskIds },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "CSV_PARSE_FAILED", message: (err as Error).message, retryable: false },
        correlationId: req.correlationId,
      });
    }
  });

  // GET /api/bulk/template — download CSV template
  router.get("/bulk/template", (_req, res) => {
    const csv = "标题,价格(元),图片URL,规格,描述\n示例商品,25.0,https://img.example.com/1.jpg;https://img.example.com/2.jpg,颜色:黑色;材质:ABS,商品描述文字\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=onzo-bulk-import-template.csv");
    res.send(csv);
  });

  return router;
}

/** Parse a single CSV line, respecting quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

async function enqueueProducts(
  products: ProductRow[],
  taskQueue: TaskQueue,
  correlationId: string
): Promise<string[]> {
  const taskIds: string[] = [];
  for (const p of products) {
    // Handle both string (xlsx) and array (csv) input
    const specImages: string[] = Array.isArray(p.specImages)
      ? (p.specImages as unknown as string[])
      : typeof p.specImages === "string"
      ? p.specImages.split(/[,;\n]+/).map((s: string) => s.trim()).filter(Boolean)
      : [];

    const specifications: Array<{ name: string; value: string }> = Array.isArray(p.specifications)
      ? (p.specifications as unknown as Array<{ name: string; value: string }>).filter((s) => s.name)
      : typeof p.specifications === "string"
      ? p.specifications.split(/[;；\n]+/).map((s) => s.trim()).filter(Boolean)
          .map((s) => { const [name, value] = s.split(/[:：]/); return { name: name?.trim() || "", value: value?.trim() || "" }; })
      : [];

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
