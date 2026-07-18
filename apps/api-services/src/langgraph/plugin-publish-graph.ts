// ============================================================
// Plugin Publish Graph — 1688 → GLM image optimize → Ozon listing
// Complete closed loop for plugin-collected products
// ============================================================

import { StateGraph, END, Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { optimizeProductImages } from "../client/glm-vision-client.js";
import { deepseekComplete } from "./client/deepseek-client.js";
import { getDb } from "../db/connection.js";
import { resolveCategory } from "../services/category-resolver.js";

const State = Annotation.Root({
  // Input from plugin
  title: Annotation<string>(),
  sourceUrl: Annotation<string>(),
  priceCny: Annotation<number>(),
  weightG: Annotation<number>(),
  imageUrls: Annotation<string[]>(),
  specs: Annotation<Array<{ name: string; value: string }>>(),

  // Image processing
  optimizedImages: Annotation<Array<{ originalUrl: string; processed: boolean; optimizedUrl?: string; steps: string[] }>>(),
  imageProcessFailed: Annotation<boolean>(),
  imageFailReason: Annotation<string>(),

  // Cost analysis
  costCny: Annotation<number>(),
  estimatedProfitRub: Annotation<number>(),
  marginPercent: Annotation<number>(),

  // DeepSeek analysis
  score: Annotation<number>(),
  titleRu: Annotation<string>(),
  descRu: Annotation<string>(),
  categoryId: Annotation<number>(),
  categoryName: Annotation<string>(),
  recommendation: Annotation<string>(),

  // Ozon publish
  productId: Annotation<number>(),
  taskId: Annotation<string>(),
  publishError: Annotation<string>(),
  published: Annotation<boolean>(),

  // Status
  steps: Annotation<string[]>(),
});

// Node 1: Process images via GLM
async function glmImageNode(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info({ title: s.title }, "PluginPublish: GLM image optimization");
  const steps = [...(s.steps || []), "GLM图片优化"];

  if (!process.env.GLM_API_KEY) {
    return { imageProcessFailed: true, imageFailReason: "GLM_API_KEY not configured", optimizedImages: [], steps };
  }

  try {
    const results = await optimizeProductImages(s.imageUrls || [], s.title);
    const failed = results.filter(r => !r.processed).length;
    return {
      optimizedImages: results,
      imageProcessFailed: failed > results.length / 2,
      imageFailReason: failed > 0 ? `${failed} images failed GLM optimization` : "",
      steps,
    };
  } catch (err) {
    return {
      imageProcessFailed: true,
      imageFailReason: (err as Error).message,
      optimizedImages: (s.imageUrls || []).map(u => ({ originalUrl: u, processed: false, steps: [] })),
      steps,
    };
  }
}

// Node 2: Cost calculation
async function costNode(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info({ title: s.title }, "PluginPublish: cost calculation");
  const steps = [...(s.steps || []), "成本拆解"];

  const exchangeRate = 11.5;
  const costCny = s.priceCny || 50;
  const ozonPriceRub = Math.round(costCny * 80); // Rough estimate
  const commission = ozonPriceRub * 0.08;
  const logistics = s.weightG > 0 ? Math.round(s.weightG * 0.3) : 50;
  const totalCost = costCny * exchangeRate + commission + logistics;
  const profit = ozonPriceRub - totalCost;
  const margin = ozonPriceRub > 0 ? Math.round((profit / ozonPriceRub) * 100) : 0;

  return { costCny: Math.round(costCny), estimatedProfitRub: Math.round(profit), marginPercent: margin, steps };
}

// Node 3: DeepSeek analysis
async function deepseekNode(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info({ title: s.title }, "PluginPublish: DeepSeek analysis");
  const steps = [...(s.steps || []), "DeepSeek分析"];

  try {
    const analysis = await deepseekComplete(
      "你是Ozon选品专家。分析商品并返回JSON: {score(0-100),titleRu(俄语标题),descRu(俄语描述),recommendation(建议)}",
      `商品: ${s.title}. 成本: ¥${s.costCny}. 预估售价: ${s.estimatedProfitRub / 0.3}₽. 利润率: ${s.marginPercent}%`,
    );
    const match = analysis.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    return {
      score: parsed.score || 50,
      titleRu: parsed.titleRu || s.title,
      descRu: parsed.descRu || "",
      recommendation: parsed.recommendation || "",
      steps,
    };
  } catch (err) {
    return { score: 0, titleRu: s.title, descRu: "", recommendation: `分析失败: ${(err as Error).message}`, steps };
  }
}

// Node 4: Ozon publish
async function publishNode(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info({ title: s.title, score: s.score }, "PluginPublish: Ozon publishing");
  const steps = [...(s.steps || []), "Ozon上架"];

  if ((s.score || 0) < 40) {
    return { published: false, publishError: `评分过低(${s.score}分)，不满足上架条件`, steps };
  }

  try {
    const cat = await resolveCategory(s.title.slice(0, 20)) || { id: 17028929, name: "Наушники и гарнитуры", parentId: 0, level: 1, path: [], typeId: 504866264 };

    const body = {
      items: [{
        offer_id: `PLUG-${Date.now().toString(36)}`,
        name: s.titleRu?.slice(0, 500) || s.title.slice(0, 500),
        description_category_id: cat.id,
        price: String(Math.round((s.costCny || 50) * 80)),
        vat: "0",
        currency_code: "CNY",
        depth: 100, height: 100, width: 100,
        weight: s.weightG || 500,
        dimension_unit: "mm",
        weight_unit: "g",
        type_id: cat.typeId,
        images: (s.imageUrls || []).slice(0, 10),
      }],
    };

    const key = (process.env.OZON_API_KEYS || "").split(",")[0] || "";
    const clientId = process.env.OZON_CLIENT_IDS || "";

    const resp = await fetch("https://api-seller.ozon.ru/v3/product/import", {
      method: "POST",
      headers: { "Client-Id": clientId, "Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as { result?: { task_id?: string } };

    if (!resp.ok || (data as { error?: string }).error) {
      return { published: false, publishError: JSON.stringify(data).slice(0, 200), steps };
    }

    return {
      published: true,
      taskId: (data.result as { task_id?: string })?.task_id || "",
      steps: [...steps, "✅ 上架成功"],
    };
  } catch (err) {
    return { published: false, publishError: (err as Error).message, steps };
  }
}

// Build
function buildPluginPublishGraph() {
  return new StateGraph(State)
    .addNode("glm_image", glmImageNode)
    .addNode("cost_calc", costNode)
    .addNode("deepseek", deepseekNode)
    .addNode("publish", publishNode)
    .addEdge("__start__", "glm_image")
    .addEdge("glm_image", "cost_calc")
    .addEdge("cost_calc", "deepseek")
    .addEdge("deepseek", "publish")
    .addEdge("publish", END)
    .compile();
}

let _g: ReturnType<typeof buildPluginPublishGraph> | null = null;

export async function executePluginPublish(input: {
  title: string; sourceUrl: string; priceCny: number;
  weightG?: number; imageUrls?: string[];
  specs?: Array<{ name: string; value: string }>;
}): Promise<typeof State.State> {
  return (getPluginPublishGraph()).invoke({
    title: input.title, sourceUrl: input.sourceUrl,
    priceCny: input.priceCny || 50, weightG: input.weightG || 500,
    imageUrls: input.imageUrls || [], specs: input.specs || [],
    optimizedImages: [], imageProcessFailed: false, imageFailReason: "",
    costCny: 0, estimatedProfitRub: 0, marginPercent: 0,
    score: 0, titleRu: "", descRu: "", categoryId: 0, categoryName: "", recommendation: "",
    productId: 0, taskId: "", publishError: "", published: false,
    steps: [],
  });
}

function getPluginPublishGraph() {
  if (!_g) _g = buildPluginPublishGraph();
  return _g;
}
