// ============================================================
// Text Client — GLM-5.2 for translation + category matching
// ============================================================

import type {
  TranslationResult,
  CategoryMatchResult,
  AttributeFillResult,
  OzonAttribute,
  OzonCategoryNode,
} from "@onzo/shared-types";
import { GlmClient, type GlmClientConfig } from "./glm-client.js";
import { TRANSLATION_SYSTEM_PROMPT, buildTranslationPrompt } from "./prompts/translate.js";
import {
  CATEGORY_SYSTEM_PROMPT,
  buildCategoryPrompt,
  formatCategoryTree,
} from "./prompts/category.js";

export class GlmTextClient {
  private client: GlmClient;
  private model: string;

  constructor(config: GlmClientConfig & { model?: string }) {
    this.client = new GlmClient(config);
    this.model = config.model ?? "glm-4-flash"; // default to flash for lower cost; use glm-5-2 for production
  }

  /**
   * Translate Chinese product info to Russian.
   */
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
      model: this.model,
      messages: [
        { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      responseFormat: { type: "json_object" },
      maxTokens: 4000,
    });

    if (response.parsed) {
      return response.parsed;
    }

    // Fallback
    return {
      titleRu: product.title,
      descriptionRu: product.description ?? "",
      specificationsRu: product.specifications,
    };
  }

  /**
   * Match a product to the most specific Ozon category.
   */
  async matchCategory(
    product: {
      title: string;
      categoryPath?: string[];
      specifications: Array<{ name: string; value: string }>;
    },
    categoryTree: OzonCategoryNode[]
  ): Promise<CategoryMatchResult> {
    const treePreview = formatCategoryTree(categoryTree);
    const userPrompt = buildCategoryPrompt(product, treePreview);

    const response = await this.client.chatCompletion<CategoryMatchResult>({
      model: this.model,
      messages: [
        { role: "system", content: CATEGORY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    if (response.parsed) {
      return response.parsed;
    }

    // Fallback — return first level suggestion
    return {
      categoryId: 0,
      categoryName: "Unknown",
      categoryPath: [],
      confidence: 0,
      reasoning: "Failed to parse category from AI response",
    };
  }

  /**
   * Fill category-specific required attributes.
   */
  async fillAttributes(
    product: {
      titleRu: string;
      descriptionRu: string;
      specifications: Array<{ name: string; value: string }>;
    },
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
      model: this.model,
      messages: [
        { role: "system", content: "You are an Ozon product data specialist. Fill in product attributes accurately." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    if (response.parsed) {
      return response.parsed;
    }

    return {
      attributes: [],
      confidence: 0,
      missingRequired: requiredAttributes.map((a) => ({
        name: a.name,
        reason: "AI response parsing failed",
      })),
    };
  }
}
