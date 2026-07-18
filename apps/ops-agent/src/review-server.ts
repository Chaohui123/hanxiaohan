// ============================================================
// Ops-Agent Review HTTP Server
// Receives listing review requests from api-services pipeline.
// Automated checks: price sanity, category compliance, image count.
// ------------------------------------------------------------
// Called by: stepOpsReview() in listing-pipeline.ts
// Port: OPS_REVIEW_PORT (default 8181)
// ============================================================

import express from "express";
import { logger } from "@onzo/logger";

const PORT = parseInt(process.env.OPS_REVIEW_PORT || "8181", 10);

const app: express.Express = express();
app.use(express.json());

interface ReviewRequest {
  taskId: string;
  sourceUrl: string;
  titleRu: string;
  descriptionRu?: string;
  categoryId: number;
  categoryName: string;
  priceRub: number;
  imageCount: number;
  specifications: Array<{ name: string; value: string }>;
  weightKg?: number;
}

interface ReviewResult {
  approved: boolean;
  reason?: string;
  riskLevel: "low" | "medium" | "high";
  suggestions: string[];
}

// ---- Automated check rules ----

function reviewListing(req: ReviewRequest): ReviewResult {
  const suggestions: string[] = [];
  let riskLevel: "low" | "medium" | "high" = "low";

  // 1. Image count check
  if (req.imageCount < 2) {
    suggestions.push("图片少于2张，Ozon推荐3张以上");
    riskLevel = "medium";
  }

  // 2. Price sanity check
  if (req.priceRub <= 0) {
    return { approved: false, reason: "价格为0或负数", riskLevel: "high", suggestions };
  }
  if (req.priceRub < 50) {
    suggestions.push("售价低于50卢布，可能不够覆盖物流成本");
    riskLevel = "medium";
  }
  if (req.priceRub > 100000) {
    suggestions.push("售价超过100000卢布，建议人工确认");
    riskLevel = "medium";
  }

  // 3. Title check
  if (!req.titleRu || req.titleRu.length < 5) {
    return { approved: false, reason: "俄语标题过短（<5字符）", riskLevel: "high", suggestions };
  }

  // 4. Category check — blocked categories
  const blockedKeywords = ["weapon", "drug", "alcohol", "tobacco", "medicine"];
  const lowerTitle = req.titleRu.toLowerCase();
  const lowerDesc = (req.descriptionRu || "").toLowerCase();
  for (const kw of blockedKeywords) {
    if (lowerTitle.includes(kw) || lowerDesc.includes(kw)) {
      return { approved: false, reason: `命中禁售关键词: ${kw}`, riskLevel: "high", suggestions };
    }
  }

  // 5. Specification completeness
  if (req.specifications.length < 2) {
    suggestions.push("规格属性少于2个，Ozon要求完整填写");
    riskLevel = riskLevel === "low" ? "medium" : riskLevel;
  }

  logger.info({
    taskId: req.taskId,
    approved: true,
    riskLevel,
    suggestionCount: suggestions.length,
  }, "OpsAgent: listing review passed");

  return { approved: true, riskLevel, suggestions };
}

// ---- Route ----

app.post("/api/review/listing", (req, res) => {
  try {
    const body = req.body as ReviewRequest;
    if (!body.taskId || !body.titleRu) {
      return res.status(400).json({ approved: false, reason: "Missing required fields" });
    }

    const result = reviewListing(body);
    res.json(result);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "OpsAgent: review error");
    res.status(500).json({ approved: false, reason: "Internal error" });
  }
});

// Health
app.get("/health", (_req, res) => res.json({ status: "ok" }));

export function startReviewServer(): void {
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "OpsAgent review HTTP server started");
  });
}
