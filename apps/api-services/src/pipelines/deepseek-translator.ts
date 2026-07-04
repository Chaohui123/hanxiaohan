// ============================================================
// DeepSeek Translator — Same interface as GlmTextClient
// Wraps DeepSeekClient for text tasks per rules.md model routing
// P0 listing tasks → deepseek-v4-flash (cost-optimized)
// ============================================================

import type { DeepSeekClient } from "@onzo/glm-integration";
import type { TranslationResult, CategoryMatchResult, AttributeFillResult, OzonCategoryNode, OzonAttribute } from "@onzo/shared-types";
import { TRANSLATION_SYSTEM_PROMPT, buildTranslationPrompt } from "@onzo/glm-integration";
import { CATEGORY_SYSTEM_PROMPT, buildCategoryPrompt, formatCategoryTree, filterCategoryTree } from "@onzo/glm-integration";
import { logger } from "@onzo/logger";

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

    logger.info({ preview: response.content.substring(0, 100) }, "Translation response");
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
    // Pre-filter tree to relevant branches based on product keywords
    // This prevents LLM hallucination from truncated tree views
    const keywords = [
      ...product.title.split(/\s+/).filter((w) => w.length > 2),
      ...(product.categoryPath ?? []),
      ...product.specifications.map((s) => s.name),
      ...product.specifications.map((s) => s.value),
    ];
    const filteredTree = filterCategoryTree(
      categoryTree as Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>,
      keywords
    );

    const treePreview = formatCategoryTree(filteredTree);
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

    logger.info({ preview: response.content.substring(0, 200) }, "Category match response");
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

  /** Retry category match. If AI still fails, fall back to programmatic tree search. */
  private async retryMatchCategory(
    product: { title: string; categoryPath?: string[]; specifications: Array<{ name: string; value: string }> },
    categoryTree: OzonCategoryNode[]
  ): Promise<CategoryMatchResult> {
    // Try AI retry with unfiltered tree (first 200 lines)
    const treePreview = formatCategoryTree(
      categoryTree as Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>
    );
    const shortTree = treePreview.split("\n").slice(0, 200).join("\n");

    const strictPrompt = `Previous attempt returned categoryId=0. This is INVALID.
Pick a REAL category ID from [brackets] in the tree below. Copy the number exactly.
Product: ${product.title}
Tree (first 200 lines):\n${shortTree}\n\nReturn JSON with a valid categoryId (NOT 0):`;

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
      // Verify the returned ID actually exists in the tree
      const exists = categoryIdExists(
        categoryTree as Array<{ categoryId: number; title: string; children: unknown[] }>,
        response.parsed.categoryId
      );
      if (exists) {
        console.log("[DeepSeek] Retry successful, verified categoryId:", response.parsed.categoryId);
        return response.parsed;
      }
      console.warn("[DeepSeek] Retry returned non-existent categoryId:", response.parsed.categoryId, "— falling back to search");
    }

    // AI failed — do programmatic search through the tree by keyword
    console.log("[DeepSeek] AI retry failed — searching tree programmatically for:", product.title);
    const searchResult = searchCategoryTree(
      categoryTree as Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>,
      [...product.title.split(/\s+/).filter((w) => w.length > 2), ...(product.categoryPath ?? [])]
    );

    if (searchResult) {
      console.log("[DeepSeek] Programmatic search found:", searchResult.categoryId, searchResult.categoryName);
      return searchResult;
    }

    console.error("[DeepSeek] All category matching methods failed.");
    return { categoryId: 0, categoryName: "Unknown", categoryPath: [], confidence: 0, reasoning: "All methods failed — manual review needed" };
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

// ---- Programmatic category tree helpers (fallback when AI fails) ----

type TreeNode = { categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> };

/** Check whether a categoryId exists anywhere in the tree. */
function categoryIdExists(nodes: TreeNode[], targetId: number): boolean {
  for (const node of nodes) {
    if (node.categoryId === targetId) return true;
    if (node.children?.length > 0) {
      if (categoryIdExists(node.children as TreeNode[], targetId)) return true;
    }
  }
  return false;
}

/** Search the tree for categories whose title matches any keyword (case-insensitive). */
function searchCategoryTree(
  nodes: TreeNode[],
  keywords: string[]
): { categoryId: number; categoryName: string; categoryPath: string[]; confidence: number; reasoning: string } | null {
  const lowerKeywords = keywords
    .filter((k) => k.length > 2)
    .map((k) => k.toLowerCase());

  // Also add Russian translations of common product types for cross-language matching
  const russianKeywords = [
    ...lowerKeywords,
    // Common Russian category keywords for cross-reference
    ...lowerKeywords.flatMap((k) => {
      if (k.includes("手机") || k.includes("phone") || k.includes("телефон")) return ["телефон", "держатель", "крепление"];
      if (k.includes("支架") || k.includes("holder") || k.includes("mount")) return ["держатель", "крепление", "подставк", "кронштейн"];
      if (k.includes("车") || k.includes("car") || k.includes("авто")) return ["авто", "автомобил", "машин"];
      return [];
    }),
  ];

  function match(title: string | undefined): boolean {
    if (!title) return false;
    const lower = title.toLowerCase();
    return lowerKeywords.some((kw) => lower.includes(kw)) || russianKeywords.some((kw) => lower.includes(kw));
  }

  // Find the best matching leaf node
  let bestMatch: { node: TreeNode; path: string[] } | null = null;
  let bestScore = 0;

  function search(nodes: TreeNode[], path: string[]) {
    for (const node of nodes) {
      const currentPath = [...path, node.title];
      if (match(node.title)) {
        // Score: deeper matches are better (leaf > branch)
        const score = currentPath.length * 10 + (node.children?.length === 0 ? 5 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { node, path: currentPath };
        }
      }
      if (node.children?.length > 0) {
        search(node.children as TreeNode[], currentPath);
      }
    }
  }

  search(nodes, []);

  if (!bestMatch) return null;

  return {
    categoryId: bestMatch.node.categoryId,
    categoryName: bestMatch.path.join(" > "),
    categoryPath: bestMatch.path,
    confidence: 0.5, // programmatic match is lower confidence than AI
    reasoning: `Programmatic keyword match: ${keywords.filter((k) => k.length > 2).join(", ")}`,
  };
}
