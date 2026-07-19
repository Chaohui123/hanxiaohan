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
  // Lithium batteries / dangerous goods (UN38.3 + MSDS + EAC required)
  "лити", "литий", "li-ion", "li-pol", "li-pol",
  "аккумулятор", "батарей", "батарея", "элемент питан",
  // Power banks / portable chargers
  "power bank", "powerbank", "пауэрбанк", "повербанк",
  "внешний аккумулятор", "портативное зарядное",
  "зарядное устройство", "зарядная станция",
  // Hazardous materials / chemicals
  "опасный груз", "легковоспламеняющ", "огнеопасн",
  "едкое вещество", "токсичн", "ядовит",
  // Electronics requiring EAC certification
  "электроудлинитель", "сетевой фильтр",
  // Laser products
  "лазерн", "laser",
  // Radio/wireless equipment (FAC/GRFC required)
  "радиопередатчик", "радиочастот",
  "беспроводной передатчик",
];

// ============================================================
// Chinese product name restricted keywords (matched before translation)
// ============================================================
export const RESTRICTED_PRODUCT_KEYWORDS_CN: Array<{
  pattern: RegExp;
  reason: string;
  severity: "block" | "warn";
  requiredCerts?: string[];
}> = [
  // ---- Lithium batteries / power banks (UN38.3 + MSDS + EAC) ----
  { pattern: /充电宝|移动电源|行动电源|随身充/i, reason: "充电宝/移动电源属于危险品(含锂电池)，需提供 UN38.3 + MSDS + EAC 三项认证后方可上架", severity: "block", requiredCerts: ["UN38.3", "MSDS", "EAC"] },
  { pattern: /锂(离子|聚合物)?(电池|电芯)/i, reason: "锂电池属于第9类危险品，需提供 UN38.3 + MSDS 认证", severity: "block", requiredCerts: ["UN38.3", "MSDS"] },
  { pattern: /蓄电池|储能电源|户外电源|应急电源/i, reason: "蓄电池/储能设备含大量锂电池，需 UN38.3 + MSDS + 危险品运输声明", severity: "block", requiredCerts: ["UN38.3", "MSDS", "Dangerous Goods Declaration"] },
  { pattern: /暖手宝.*充电|充电.*暖手宝/i, reason: "充电暖手宝含锂电池，需 UN38.3 + MSDS 认证", severity: "block", requiredCerts: ["UN38.3", "MSDS"] },
  { pattern: /锂电池.*车|电动车.*锂|平衡车|滑板车.*电/i, reason: "电动交通工具含大容量锂电池，运输限制严格，需 UN38.3 + MSDS + EAC + 危险品运输声明", severity: "block", requiredCerts: ["UN38.3", "MSDS", "EAC", "Dangerous Goods Declaration"] },
  // ---- Electronics requiring EAC ----
  { pattern: /电源适配器|充电器|充电头|快充头/i, reason: "电源适配器属于低压设备，俄罗斯强制 EAC 认证", severity: "warn", requiredCerts: ["EAC"] },
  { pattern: /数据线|充电线|转换头|插头|插座|排插/i, reason: "电子配件可能需要 EAC 符合性声明", severity: "warn", requiredCerts: ["EAC Declaration"] },
  // ---- Wireless/radio products ----
  { pattern: /蓝牙(?!.*不).*?[器机]/i, reason: "蓝牙设备含无线发射模块，俄罗斯需 FAC/GRFC 认证", severity: "warn", requiredCerts: ["FAC/GRFC"] },
  { pattern: /wifi|无线网卡|无线路由|zigbee|射频/i, reason: "无线通信设备需 FAC/GRFC + EAC 认证", severity: "warn", requiredCerts: ["FAC/GRFC", "EAC"] },
  // ---- Cosmetics / chemicals ----
  { pattern: /化妆品|护肤品|面膜|口红|粉底|眼影|腮红/i, reason: "化妆品需俄罗斯 GOST 化妆品安全认证 + 成分声明", severity: "warn", requiredCerts: ["GOST Cosmetic", "Ingredient Declaration"] },
  { pattern: /香水|指甲油|染发|脱毛|美白霜/i, reason: "特殊化妆品需 SGR(国家注册证)", severity: "block", requiredCerts: ["SGR"] },
  // ---- Food contact / children ----
  { pattern: /儿童|婴幼儿|宝宝|婴儿|幼儿|新生儿/i, reason: "儿童用品需 EAC 儿童安全认证(TP TC 007/2011)", severity: "block", requiredCerts: ["EAC Children (TP TC 007/2011)"] },
  { pattern: /食品接触|餐具|厨具.*塑料|硅胶.*餐具/i, reason: "食品接触材料需 EAC 食品接触声明", severity: "warn", requiredCerts: ["EAC Food Contact"] },
  // ---- Medical devices ----
  { pattern: /血压计|血糖仪|体温计|血氧仪|雾化器|制氧机/i, reason: "医疗器械需 Росздравнадзор 注册证", severity: "block", requiredCerts: ["Росздравнадзор Registration"] },
  { pattern: /口罩.*医|医.*口罩|防护服|隔离衣|手术衣/i, reason: "医用防护用品需医疗器械注册证", severity: "block", requiredCerts: ["Medical Device Registration"] },
  // ---- Counterfeit-prone categories ----
  { pattern: /airpods|air.?pod/i, reason: "Apple 品牌授权验证 — 非授权经销商上架将被 Ozon 下架罚款", severity: "block" },
  { pattern: /三星|samsung|苹果|apple|华为|huawei|小米|xiaomi|索尼|sony/i, reason: "品牌商品需提供品牌授权书或经销商证明", severity: "warn", requiredCerts: ["Brand Authorization"] },
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
        // Lithium batteries / dangerous goods — hard block without certification
        "лити", "литий", "аккумулятор", "power bank", "powerbank",
        "опасный груз", "легковоспламеняющ", "токсичн",
        // Medical without registration
        "лекарственн", "лекарство",
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

// ============================================================
// P6 Enhanced: Chinese product name + certification checks
// ============================================================

export interface ProductComplianceResult {
  allowed: boolean;
  blocked: boolean;
  blockedReason?: string;
  requiredCerts: string[];
  warnings: string[];
  severity: "pass" | "warn" | "block";
}

/**
 * Check Chinese product title/description for restricted categories.
 * Called at listing pipeline step 7 (before Ozon draft creation).
 */
export function checkChineseProductCompliance(
  titleZh: string,
  descriptionZh?: string,
): ProductComplianceResult {
  const text = `${titleZh} ${descriptionZh || ""}`;
  const requiredCerts: string[] = [];
  const warnings: string[] = [];
  let blocked = false;
  let blockedReason: string | undefined;

  for (const rule of RESTRICTED_PRODUCT_KEYWORDS_CN) {
    if (rule.pattern.test(text)) {
      if (rule.severity === "block") {
        blocked = true;
        blockedReason = rule.reason;
      }
      if (rule.requiredCerts) {
        requiredCerts.push(...rule.requiredCerts);
      }
      warnings.push(rule.reason);
    }
  }

  // Dedup certs
  const uniqueCerts = [...new Set(requiredCerts)];

  return {
    allowed: !blocked,
    blocked,
    blockedReason,
    requiredCerts: uniqueCerts,
    warnings,
    severity: blocked ? "block" : warnings.length > 0 ? "warn" : "pass",
  };
}

/**
 * Check if a product requires specific Russian certifications.
 * Returns the list of required certifications.
 */
export function getRequiredCertifications(
  titleZh: string,
  categoryName?: string,
  categoryPath?: string[],
): { required: string[]; recommended: string[] } {
  const result = checkChineseProductCompliance(titleZh);
  const required: string[] = [];
  const recommended: string[] = [];

  // From Chinese name detection
  if (result.requiredCerts.length > 0) {
    for (const cert of result.requiredCerts) {
      if (result.blocked) {
        required.push(cert);
      } else {
        recommended.push(cert);
      }
    }
  }

  // From Russian category path
  const fullPath = [...(categoryPath || []), categoryName || ""].join(" > ").toLowerCase();

  // Electronics with AC power → EAC mandatory
  if (/электроник|техник|оборудован/.test(fullPath)) {
    if (!required.includes("EAC")) recommended.push("EAC");
  }

  // Wireless → FAC/GRFC
  if (/беспроводн|bluetooth|wifi|radio/i.test(fullPath)) {
    if (!required.includes("FAC/GRFC")) recommended.push("FAC/GRFC");
  }

  return { required, recommended };
}
