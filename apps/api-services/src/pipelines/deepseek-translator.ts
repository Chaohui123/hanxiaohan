// ============================================================
// DeepSeek Translator — Same interface as GlmTextClient
// Wraps DeepSeekClient for text tasks per rules.md model routing
// P0 listing tasks → deepseek-v4-flash (cost-optimized)
// ============================================================

import type { DeepSeekClient } from "@onzo/glm-integration";
import type { TranslationResult, CategoryMatchResult, AttributeFillResult, OzonCategoryNode, OzonAttribute } from "@onzo/shared-types";
import { TRANSLATION_SYSTEM_PROMPT, buildTranslationPrompt } from "@onzo/glm-integration";
import { CATEGORY_SYSTEM_PROMPT, buildCategoryPrompt, formatCategoryTree } from "@onzo/glm-integration";

export class DeepSeekTranslator {
  private client: DeepSeekClient;

  constructor(client: DeepSeekClient) {
    this.client = client;
  }

  async translateProduct(product: {
    title: string;
    description?: string;
    specifications: Array<{ name: string; value: string }>;
    ocrTexts?: string[];
  }): Promise<TranslationResult> {
    const userPrompt = buildTranslationPrompt({
      title: product.title,
      description: product.description ?? "",
      specifications: product.specifications,
      ocrTexts: product.ocrTexts,
    });

    const response = await this.client.chatCompletion<TranslationResult>({
      model: "flash",
      messages: [
        { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: 8000,
      responseFormat: { type: "json_object" },
    });

    console.log("[DeepSeek] Translation response:", response.content.substring(0, 100));
    if (response.parsed) return response.parsed;

    return {
      titleRu: product.title,
      descriptionRu: product.description ?? "",
      specificationsRu: product.specifications,
    };
  }

  async matchCategory(
    product: { title: string; categoryPath?: string[]; specifications: Array<{ name: string; value: string }> },
    categoryTree: OzonCategoryNode[]
  ): Promise<CategoryMatchResult> {
    const treePreview = formatCategoryTree(categoryTree as Array<{ categoryId: number; title: string; children: unknown[] }>);
    const userPrompt = buildCategoryPrompt(product, treePreview);

    const response = await this.client.chatCompletion<CategoryMatchResult>({
      model: "flash",
      messages: [
        { role: "system", content: CATEGORY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8000,
      responseFormat: { type: "json_object" },
    });

    console.log("[DeepSeek] Category match response content:", response.content.substring(0, 200));
    if (response.parsed) {
      console.log("[DeepSeek] Parsed category:", response.parsed.categoryId, response.parsed.categoryName);

      // Validate categoryId is a real positive number
      if (response.parsed.categoryId > 0) {
        return response.parsed;
      }

      // categoryId=0 — retry once with stronger prompt
      console.warn("[DeepSeek] categoryId=0 on first attempt, retrying...");
      return await this.retryMatchCategory(product, categoryTree);
    }

    console.warn("[DeepSeek] Failed to parse category match. Raw:", response.content.substring(0, 300));
    return { categoryId: 0, categoryName: "Unknown", categoryPath: [], confidence: 0, reasoning: "Failed to parse" };
  }

  /** Retry category match with a stricter prompt when first attempt returns 0. */
  private async retryMatchCategory(
    product: { title: string; categoryPath?: string[]; specifications: Array<{ name: string; value: string }> },
    categoryTree: OzonCategoryNode[]
  ): Promise<CategoryMatchResult> {
    const treePreview = formatCategoryTree(categoryTree as Array<{ categoryId: number; title: string; children: unknown[] }>);

    // Truncate tree for retry to avoid token limits
    const shortTree = treePreview.split("\n").slice(0, 100).join("\n");

    const strictPrompt = `Previous attempt returned categoryId=0. This is INVALID.
Pick a REAL category ID from [brackets] in the tree below.
Product: ${product.title}
Tree (first 100 lines):\n${shortTree}\n\nReturn JSON with a valid categoryId (NOT 0):`;

    const response = await this.client.chatCompletion<CategoryMatchResult>({
      model: "flash",
      messages: [
        { role: "system", content: "You are an Ozon category specialist. Return a REAL numeric categoryId from the tree. Never return 0." },
        { role: "user", content: strictPrompt },
      ],
      temperature: 0.1,
      maxTokens: 4000,
      responseFormat: { type: "json_object" },
    });

    if (response.parsed?.categoryId && response.parsed.categoryId > 0) {
      console.log("[DeepSeek] Retry successful, categoryId:", response.parsed.categoryId);
      return response.parsed;
    }

    console.error("[DeepSeek] Retry also failed. categoryId:", response.parsed?.categoryId ?? "undefined");
    return { categoryId: 0, categoryName: "Unknown", categoryPath: [], confidence: 0, reasoning: "Retry failed — manual review needed" };
  }

  async fillAttributes(
    product: { titleRu: string; descriptionRu: string; specifications: Array<{ name: string; value: string }> },
    categoryId: number,
    requiredAttributes: OzonAttribute[]
  ): Promise<AttributeFillResult> {
    const attrDesc = requiredAttributes
      .map((a) => `  - ${a.name} (id=${a.id}, type=${a.type}, required=${a.isRequired}${a.dictionary ? `, options: [${a.dictionary.map((d) => d.value).join(", ")}]` : ""})`)
      .join("\n");

    const prompt = `Fill in the Ozon product attributes based on the product information.

PRODUCT:
Title: ${product.titleRu}
Description: ${product.descriptionRu}
Specs: ${product.specifications.map((s) => `${s.name}: ${s.value}`).join(", ")}

REQUIRED ATTRIBUTES for category ${categoryId}:
${attrDesc}

For each attribute, provide the best matching value. Only use values from the dictionary when provided.
If you cannot determine a value, mark it as missing with a reason.

Return JSON:
{
  "attributes": [{"attributeId": 123, "name": "Color", "value": "Черный"}],
  "confidence": 0.8,
  "missingRequired": [{"name": "Material", "reason": "Not specified in product data"}]
}`;

    const response = await this.client.chatCompletion<AttributeFillResult>({
      model: "flash",
      messages: [
        { role: "system", content: "You are an Ozon product data specialist. Fill in product attributes accurately." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    if (response.parsed) return response.parsed;

    return {
      attributes: [],
      confidence: 0,
      missingRequired: requiredAttributes.map((a) => ({ name: a.name, reason: "AI response parsing failed" })),
    };
  }
}
