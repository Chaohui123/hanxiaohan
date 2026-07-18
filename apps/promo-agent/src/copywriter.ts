import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { promoApi } from "./api-client.js";
import { logger } from "@onzo/logger";
import { auditText, formatAuditReport, type AuditResult } from "./compliance/index.js";

// ---- 类型 ----

export interface CopyResult {
  offerId: string;
  titleRu: string;
  descriptionRu: string;
  features: string[];
  tokens: number;
  audit?: AuditResult;
}

export interface ImageAnalysis {
  offerId: string;
  imageUrl: string;
  score: number; // 1-100
  issues: string[];
  suggestions: string[];
}

// ---- AI API 配置 ----

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

const GLM_API_KEY = process.env.GLM_API_KEY || "";
const GLM_BASE = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";

// ---- 待确认文案缓存 ----

const pendingCopy = new Map<string, CopyResult>(); // key = `${chatId}:${offerId}`

// ---- System Prompts ----

const COPY_SYSTEM_PROMPT = `你是 Ozon 跨境电商俄语文案专家。你的任务是为中国商品生成地道的俄语商品文案，面向俄罗斯消费者。

要求：
1. 标题（title_ru）：
   - 纯俄语，≤70 字符
   - 包含核心关键词（品类、材质、用途）
   - 避免中式俄语直译
   - 参考热销竞品的高频词汇

2. 描述（description_ru）：
   - 纯俄语，≤5000 字符
   - 结构：产品概述 → 核心卖点 → 规格参数 → 适用场景 → 售后保障
   - 使用俄语电商惯用表达（не упустите шанс, ограниченное предложение 等适度使用）
   - 合理使用 HTML 标签：<p>, <br>, <b>, <ul>, <li>

3. 关键特性（features）：
   - 3-5 条俄语卖点短语
   - 每条 ≤80 字符
   - 突出与竞品的差异化优势

如果输入包含竞品热销文案，参考其结构和关键词，但不要直接抄袭。

⚠️ 合规要求（必须遵守）：
1. 禁止使用最高级声明：лучший, номер один, №1, самый, единственный
2. 禁止无依据的保证：гарантия, 100%, обязательно
3. 禁止医疗效果声明：лечит, излечивает, лекарство, похудение
4. 禁止虚假稀缺性：ограниченное предложение, последний шанс, торопитесь
5. 禁止与竞品对比：дешевле чем, лучше чем
6. 禁止未授权品牌声明：оригинал, подлинный (除非有品牌授权)
7. 禁止夸张修饰：супер, мега, хит, топ
8. 促销词谨慎使用：акция, распродажа, скидка (仅限真实促销)
9. 认证声明需有依据：FDA, CE, ISO, сертифицировано (无证书不得提及)
10. 使用客观描述：качественный, популярный, удобный, надёжный`;

const IMAGE_ANALYSIS_PROMPT = `你是一个电商主图质量审核专家。请分析以下商品主图，按 Ozon 平台标准评分。

评分维度（每项 1-20 分，总分 100）：
1. 白底/纯色背景 — Ozon 要求纯白底（#FFFFFF），带纹理/阴影/渐变的扣分
2. 商品占比 — 商品占画面 >80% 为佳
3. 拍摄角度 — 正面/45° 角为主，多角度展示加分
4. 清晰度 — 无模糊、噪点、压缩伪影
5. 无违规 — 无水印、Logo、边框、促销文字

请用 JSON 格式输出：
{
  "score": 75,
  "issues": ["背景非纯白（偏灰）", "商品占比不足 60%"],
  "suggestions": ["使用 #FFFFFF 纯白背景重新拍摄", "裁切空白区域使商品占比 ≥80%", "添加侧面角度展示"]
}`;

// ---- 核心功能 ----

/** 生成俄语商品文案 */
export async function generateCopy(
  config: ApiConfig,
  offerId: string,
  chatId: string,
): Promise<CopyResult | null> {
  // 1. 获取商品详情
  let product: Record<string, unknown> = {};
  try {
    product = await promoApi.getProduct(config, offerId);
  } catch (err) {
    logger.error({ err, offerId }, "Failed to fetch product for copy generation");
    throw new Error(`无法获取商品信息: ${(err as Error).message}`);
  }

  const name = String(product.name || product.title || "");
  const description = String(product.description || "");
  const attributes = JSON.stringify(product.attributes || product.properties || {});

  // 2.5 RAG 检索相似文案
  let ragContext = "";
  try {
    const ragResp = await fetch(`${config.apiBase}/api/rag/copy/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query: `${name} ${product.category || product.categoryId || ""}`, category: "product_title", topK: 3 }),
      signal: AbortSignal.timeout(10_000),
    });

    if (ragResp.ok) {
      const ragData = await ragResp.json() as { results?: Array<{ score: number; content?: string; original_text?: string }> };
      if (ragData.results?.length) {
        ragContext = ragData.results
          .map((r) => `参考文案(相似度${(r.score || 0).toFixed(2)}): ${r.content || r.original_text || ""}`)
          .join("\n");
      }
    }
  } catch (err) {
    logger.warn({ err }, "RAG copy search failed, continuing without context");
  }

  // 2.6 RAG 合规知识库检索 — 注入Ozon规则上下文
  let ragCompliance = "";
  try {
    const compResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query: `${name} ${product.category || ""}`, scenario: "compliance", topK: 3 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (compResp.ok) {
      const compData = await compResp.json() as { results?: Array<{ title?: string; content?: string }> };
      if (compData.results?.length) {
        ragCompliance = compData.results
          .map((r) => `[合规规则-${r.title || ""}]: ${(r.content || "").slice(0, 300)}`)
          .join("\n");
      }
    }
  } catch { /* non-blocking */ }

  // 3. 构建 prompt
  const complianceNote = ragCompliance
    ? `\n\n⚠️ Ozon平台合规规则（必须遵守）：\n${ragCompliance}\n\n请确保生成的文案不违反以上规则。`
    : "";
  const systemPrompt = (ragContext
    ? `你是一个俄罗斯电商文案专家。\n\n以下是同类商品的优秀文案参考：\n${ragContext}\n\n请参考以上文案的风格和结构，但不要直接复制。${complianceNote}`
    : COPY_SYSTEM_PROMPT + complianceNote);

  const userPrompt = [
    "请为以下商品生成俄语文案：",
    "",
    `中文名称: ${name}`,
    description ? `中文描述: ${description}` : "",
    attributes ? `商品属性: ${attributes}` : "",
    "",
    "请严格按以下 JSON 格式输出（不要输出其他内容）：",
    '{',
    '  "title_ru": "俄语标题",',
    '  "description_ru": "俄语描述",',
    '  "features": ["卖点1", "卖点2", "卖点3"]',
    '}',
  ]
    .filter(Boolean)
    .join("\n");

  // 4. 调用 DeepSeek
  if (!DEEPSEEK_API_KEY) {
    throw new Error("未配置 DEEPSEEK_API_KEY");
  }

  const resp = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek API ${resp.status}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { total_tokens: number };
  };

  const raw = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens || 0;

  // 4. 解析 JSON 响应
  let parsed: { title_ru?: string; description_ru?: string; features?: string[] };
  try {
    // 提取 JSON 块（可能被 markdown ``` 包裹）
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const jsonStr = (jsonMatch[1] || raw).trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    logger.warn({ raw: raw.slice(0, 500) }, "Failed to parse DeepSeek JSON, using raw text");
    parsed = { title_ru: name, description_ru: raw, features: [] };
  }

  const result: CopyResult = {
    offerId,
    titleRu: (parsed.title_ru || name).slice(0, 70),
    descriptionRu: (parsed.description_ru || raw).slice(0, 5000),
    features: (parsed.features || []).slice(0, 5),
    tokens,
  };

  // 5. 合规审计（分字段独立审计）
  const titleAudit = auditText(result.titleRu);
  const descAudit = auditText(result.descriptionRu);
  const featuresAudit = auditText(result.features.join(" "));

  // Always apply auto-fixes to each field independently
  result.titleRu = titleAudit.autoFixed.slice(0, 70);
  result.descriptionRu = descAudit.autoFixed.slice(0, 5000);
  // Reconstruct features from the auto-fixed text (features were joined with space for audit)
  result.features = featuresAudit.autoFixed.split(" ").filter(Boolean).slice(0, 5);
  if (result.features.length === 0) result.features = parsed.features?.slice(0, 5) || [];

  const combinedAudit: AuditResult = {
    passed: titleAudit.passed && descAudit.passed && featuresAudit.passed,
    score: Math.min(titleAudit.score, descAudit.score, featuresAudit.score),
    findings: [...titleAudit.findings, ...descAudit.findings, ...featuresAudit.findings],
    blockedCount: titleAudit.blockedCount + descAudit.blockedCount + featuresAudit.blockedCount,
    warnCount: titleAudit.warnCount + descAudit.warnCount + featuresAudit.warnCount,
    autoFixed: `${result.titleRu}\n---\n${result.descriptionRu}`,
    remainingIssues: [...titleAudit.remainingIssues, ...descAudit.remainingIssues, ...featuresAudit.remainingIssues],
  };

  if (!combinedAudit.passed) {
    logger.info({ offerId, blocked: combinedAudit.blockedCount, warned: combinedAudit.warnCount }, "Copy auto-fixed by compliance audit");
  }

  (result as CopyResult & { audit: AuditResult }).audit = combinedAudit;

  // 6. 缓存待确认
  pendingCopy.set(`${chatId}:${offerId}`, result);

  return result;
}

/** 分析商品主图质量 */
export async function analyzeImage(
  config: ApiConfig,
  offerId: string,
): Promise<ImageAnalysis | null> {
  if (!GLM_API_KEY) {
    throw new Error("未配置 GLM_API_KEY");
  }

  // 1. 获取商品图片
  let product: Record<string, unknown> = {};
  try {
    product = await promoApi.getProduct(config, offerId);
  } catch (err) {
    logger.error({ err, offerId }, "Failed to fetch product for image analysis");
    throw new Error(`无法获取商品信息: ${(err as Error).message}`);
  }

  const images = (product.images as string[]) || [];
  if (images.length === 0) {
    throw new Error("该商品无主图");
  }

  const imageUrl = images[0];

  // 2. 调用 GLM-4V 分析图片
  const resp = await fetch(`${GLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-4v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_ANALYSIS_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`GLM API ${resp.status}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices?.[0]?.message?.content || "";

  // 3. 解析 JSON 响应
  let parsed: { score?: number; issues?: string[]; suggestions?: string[] };
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    parsed = JSON.parse((jsonMatch[1] || raw).trim());
  } catch {
    logger.warn({ raw: raw.slice(0, 500) }, "Failed to parse GLM JSON");
    parsed = { score: 50, issues: ["无法解析分析结果"], suggestions: [] };
  }

  return {
    offerId,
    imageUrl,
    score: Math.min(100, Math.max(0, parsed.score || 50)),
    issues: parsed.issues || [],
    suggestions: parsed.suggestions || [],
  };
}

/** 应用文案到商品（一键上架） */
export async function applyCopy(
  _bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
  offerId: string,
): Promise<string> {
  const key = `${chatId}:${offerId}`;
  const copy = pendingCopy.get(key);

  if (!copy) {
    return "⚠️ 未找到待确认的文案。请先用 /promo copy <offerId> 生成文案。";
  }

  pendingCopy.delete(key);

  // 最终合规检查 — 提交前强制二次审计
  const finalTitleAudit = auditText(copy.titleRu);
  const finalDescAudit = auditText(copy.descriptionRu);

  if (!finalTitleAudit.passed || !finalDescAudit.passed) {
    const report = formatAuditReport({
      passed: false,
      score: Math.min(finalTitleAudit.score, finalDescAudit.score),
      findings: [...finalTitleAudit.findings, ...finalDescAudit.findings],
      blockedCount: finalTitleAudit.blockedCount + finalDescAudit.blockedCount,
      warnCount: finalTitleAudit.warnCount + finalDescAudit.warnCount,
      autoFixed: "",
      remainingIssues: [...finalTitleAudit.remainingIssues, ...finalDescAudit.remainingIssues],
    });
    logger.error({ offerId, findings: finalTitleAudit.findings.length + finalDescAudit.findings.length }, "Copy blocked by compliance audit");
    return `🚫 文案被合规审计拦截，禁止发布！\n\n${report}\n\n请修改后重新生成文案。`;
  }

  try {
    await promoApi.updateProduct(config, offerId, {
      name: copy.titleRu,
      description: copy.descriptionRu,
    });

    logger.info({ offerId }, "Copy applied to product");

    // Auto-save to RAG knowledge base (async, don't block)
    fetch(`${config.apiBase}/api/rag/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({
        category: "product_title",
        originalText: copy.offerId,
        optimizedText: copy.titleRu,
        optimizationNotes: `Auto-generated copy for ${copy.offerId}`,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => { /* fire-and-forget */ });

    return [
      "✅ 文案已更新到商品",
      "",
      `📦 OfferID: ${offerId}`,
      `📝 标题: ${copy.titleRu}`,
      `📄 描述: ${copy.descriptionRu.slice(0, 200)}${copy.descriptionRu.length > 200 ? "..." : ""}`,
      copy.features.length > 0 ? `🏷 卖点:\n${copy.features.map((f) => `   • ${f}`).join("\n")}` : "",
      "",
      `🔋 Tokens: ${copy.tokens}`,
    ].join("\n");
  } catch (err) {
    logger.error({ err, offerId }, "Failed to apply copy");
    return `❌ 更新失败: ${(err as Error).message}`;
  }
}

/** 获取待确认文案 */
export function getPendingCopy(chatId: string, offerId: string): CopyResult | undefined {
  return pendingCopy.get(`${chatId}:${offerId}`);
}

/** 是否有待确认文案 */
export function hasPendingCopy(chatId: string): boolean {
  for (const key of pendingCopy.keys()) {
    if (key.startsWith(`${chatId}:`)) return true;
  }
  return false;
}

/** 格式化文案用于显示 */
export function formatCopyResult(copy: CopyResult): string {
  const scoreEmoji = copy.titleRu.length <= 70 ? "✅" : "⚠️";

  const lines = [
    "✍️ **AI 生成俄语文案**",
    "",
    `📦 OfferID: ${copy.offerId}`,
    "",
    `${scoreEmoji} **标题** (${copy.titleRu.length}/70 字符)`,
    `\`${copy.titleRu}\``,
    "",
    `📄 **描述** (${copy.descriptionRu.length}/5000 字符)`,
    copy.descriptionRu.length > 800
      ? copy.descriptionRu.slice(0, 800) + "\n\n... (截断，完整内容已缓存)"
      : copy.descriptionRu,
    "",
    copy.features.length > 0
      ? `🏷 **关键特性**\n${copy.features.map((f) => `• ${f}`).join("\n")}`
      : "",
    "",
    `🔋 Tokens: ${copy.tokens}`,
  ];

  // 合规审计报告
  if (copy.audit) {
    lines.push("");
    lines.push(formatAuditReport(copy.audit));
    if (copy.audit.passed) {
      lines.push("", `回复 **"yes copy ${copy.offerId}"** 确认一键上架`);
    } else {
      lines.push("", "⚠️ 文案已自动修复部分违规词，请审核后再确认上架");
      lines.push(`回复 **"yes copy ${copy.offerId}"** 确认上架（修复后版本）`);
    }
  } else {
    lines.push("");
    lines.push(`回复 **"yes copy ${copy.offerId}"** 确认一键上架`);
  }

  return lines.join("\n");
}

/** 格式化图片分析结果 */
export function formatImageAnalysis(analysis: ImageAnalysis): string {
  const level = analysis.score >= 80 ? "🟢" : analysis.score >= 60 ? "🟡" : "🔴";
  const label = analysis.score >= 80 ? "优秀" : analysis.score >= 60 ? "一般" : "较差";

  return [
    "🖼 **主图质量分析**",
    "",
    `${level} 综合评分: **${analysis.score}/100** (${label})`,
    "",
    analysis.issues.length > 0
      ? `⚠️ **发现的问题**\n${analysis.issues.map((i) => `• ${i}`).join("\n")}`
      : "✅ 无明显问题",
    "",
    analysis.suggestions.length > 0
      ? `💡 **改进建议**\n${analysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "",
  ].join("\n");
}
