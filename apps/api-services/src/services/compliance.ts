// ============================================================
// Compliance Check — Sanctioned & restricted category validation
// Prevents listing products in Ozon-prohibited categories
// ============================================================

import type { OzonCategoryNode } from "@onzo/shared-types";

// Ozon restricted/prohibited category keywords (Russian)
// Reference: https://docs.ozon.ru/common/pravila-razmeshcheniya/nedopustimye-tovary/
const RESTRICTED_CATEGORY_KEYWORDS = [
  // Alcohol & tobacco
  "алкогол", "спирт", "водка", "пиво", "вино", "коньяк",
  "табак", "сигарет", "кальян", "вейп", "никотин",
  // Weapons & dangerous items
  "оружи", "пистолет", "патрон", "взрывчат",
  "нож", "холодное оружие",
  // Drugs & medicine
  "наркоти", "психотроп", "лекарственн",
  "медицинск", "лекарство", "препарат",
  "биологически активн", "БАД",
  // Animals & plants
  "животн", "растен", "семен",
  // Counterfeit & IP
  "реплик", "копия бренда", "подделк",
  // Adult content
  "интим", "секс", "эротик",
  "порнограф",
  // Financial products
  "криптовалют", "ценные бумаг",
  // Precious metals
  "драгоценн",
  // Food (requires special certification)
  "продукты питан", "питание",
  // Gambling
  "азартн", "лотере",
];

// Category IDs from Ozon that are always blocked
const BLOCKED_CATEGORY_IDS = new Set<number>([
  // These IDs change, so keyword matching is the primary check
]);

export interface ComplianceResult {
  allowed: boolean;
  warnings: string[];
  blocked: boolean;
  blockedReason?: string;
}

/**
 * Check if a matched Ozon category is in a restricted/sanctioned category.
 * Returns warnings for borderline categories and blocks prohibited ones.
 */
export function checkCategoryCompliance(
  categoryId: number,
  categoryName: string,
  categoryPath: string[]
): ComplianceResult {
  const warnings: string[] = [];
  const fullPath = [...categoryPath, categoryName].join(" > ").toLowerCase();
  const nameLower = categoryName.toLowerCase();

  // Check against blocked IDs
  if (BLOCKED_CATEGORY_IDS.has(categoryId)) {
    return {
      allowed: false,
      warnings,
      blocked: true,
      blockedReason: `Category ID ${categoryId} is on the Ozon prohibited list`,
    };
  }

  // Check category name and path against restricted keywords
  for (const keyword of RESTRICTED_CATEGORY_KEYWORDS) {
    if (nameLower.includes(keyword) || fullPath.includes(keyword)) {
      // High-risk keywords → hard block
      const highRisk = [
        "алкогол", "спирт", "табак", "сигарет", "оружи", "пистолет",
        "наркоти", "психотроп", "взрывчат", "порнограф",
      ];

      if (highRisk.some((kw) => nameLower.includes(kw) || fullPath.includes(kw))) {
        return {
          allowed: false,
          warnings,
          blocked: true,
          blockedReason: `Category matches prohibited keyword "${keyword}" — category: ${categoryName}`,
        };
      }

      // Medium risk → warning
      warnings.push(`Category "${categoryName}" may be restricted (matched: "${keyword}"). Verify Ozon policy before listing.`);
    }
  }

  return {
    allowed: true,
    warnings,
    blocked: false,
  };
}

/**
 * Check product title/description for compliance issues.
 */
export function checkProductCompliance(titleRu: string, descriptionRu: string): ComplianceResult {
  const warnings: string[] = [];
  const text = `${titleRu} ${descriptionRu}`.toLowerCase();

  // Check for Ozon content policy violations
  const bannedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /гаранти[рую]\s+результат/i, reason: "Exaggerated claims not allowed on Ozon" },
    { pattern: /лучш[ийаяеие]\s+(в|на)\s+(мире|россии|ozon)/i, reason: "Superlative claims require proof" },
    { pattern: /\b(?:whatsapp|telegram|wechat|viber|instagram|vk\.com|facebook)\b.*\b(?:заказ|order|buy|куп)/i, reason: "External purchase links not allowed" },
    { pattern: /бесплатн[оаыей]/i, reason: "'Free' claims flagged by Ozon moderation" },
  ];

  for (const { pattern, reason } of bannedPatterns) {
    if (pattern.test(text)) {
      warnings.push(`Content policy: ${reason}`);
    }
  }

  return {
    allowed: true, // warnings don't block, just flag
    warnings,
    blocked: false,
  };
}

/**
 * Full compliance check — category + product content.
 */
export function fullComplianceCheck(params: {
  categoryId: number;
  categoryName: string;
  categoryPath: string[];
  titleRu: string;
  descriptionRu: string;
}): ComplianceResult {
  const catResult = checkCategoryCompliance(params.categoryId, params.categoryName, params.categoryPath);
  if (catResult.blocked) return catResult;

  const productResult = checkProductCompliance(params.titleRu, params.descriptionRu);

  return {
    allowed: catResult.allowed && productResult.allowed,
    warnings: [...catResult.warnings, ...productResult.warnings],
    blocked: catResult.blocked || productResult.blocked,
    blockedReason: catResult.blockedReason,
  };
}
