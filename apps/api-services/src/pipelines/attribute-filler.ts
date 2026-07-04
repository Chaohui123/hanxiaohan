// ============================================================
// Attribute Filler — extracts common required attributes from
// product specs when DeepSeek category match returns empty
// ============================================================

import type { OzonAttribute } from "@onzo/shared-types";

export interface FilledAttribute {
  attributeId: number;
  name: string;
  value: string;
}

// Common Ozon required attribute IDs (may vary per category, these are fallback guesses)
const COMMON_ATTRIBUTE_MAP: Record<string, number> = {
  "Цвет": 0, "color": 0, "цвет": 0,
  "Материал": 0, "material": 0, "материал": 0,
  "Размер": 0, "size": 0, "размер": 0,
  "Вес": 0, "weight": 0, "вес": 0,
};

/**
 * Heuristic fill: extract color, material, size, weight from product specs
 * when DeepSeek API returns empty attributes. Matches against Ozon attribute names.
 */
export function heuristicFillAttributes(
  specifications: Array<{ name: string; value: string }>,
  requiredAttributes: OzonAttribute[]
): FilledAttribute[] {
  const filled: FilledAttribute[] = [];

  // Build a lookup from spec names to values (case-insensitive)
  const specMap = new Map<string, string>();
  for (const spec of specifications) {
    specMap.set(spec.name.toLowerCase(), spec.value);
    // Also index by common Russian equivalents
    if (spec.name === "颜色" || spec.name === "Color") specMap.set("цвет", spec.value);
    if (spec.name === "材质" || spec.name === "Material") specMap.set("материал", spec.value);
    if (spec.name === "尺码" || spec.name === "Size" || spec.name === "尺寸") specMap.set("размер", spec.value);
    if (spec.name === "重量" || spec.name === "Weight") specMap.set("вес", spec.value);
  }

  for (const attr of requiredAttributes) {
    if (!attr.isRequired) continue;

    const attrNameLower = attr.name.toLowerCase();
    // Direct match on Ozon attribute name
    let value = specMap.get(attrNameLower);

    // Try partial keyword match
    if (!value) {
      for (const [specName, specValue] of specMap) {
        if (attrNameLower.includes(specName) || specName.includes(attrNameLower)) {
          value = specValue;
          break;
        }
      }
    }

    // If Ozon attribute has a dictionary, try to match value against dictionary
    if (value && attr.dictionary?.length) {
      const matched = attr.dictionary.find(
        (d) => d.value.toLowerCase() === value!.toLowerCase()
      );
      if (matched) value = matched.value;
      else value = attr.dictionary[0].value; // fallback to first option
    }

    if (!value && attr.dictionary?.length) {
      // No spec found, use first dictionary value as default
      value = attr.dictionary[0].value;
    }

    if (value) {
      filled.push({ attributeId: attr.id, name: attr.name, value });
    }
  }

  return filled;
}

/**
 * Default fallback attributes for categories where we can't get required attrs.
 * Covers the most common 4: Цвет, Материал, Размер, Вес.
 */
export function buildDefaultAttributes(
  product: { title: string; specifications: Array<{ name: string; value: string }> }
): FilledAttribute[] {
  const specMap = new Map<string, string>();
  for (const s of product.specifications) specMap.set(s.name, s.value);

  const defaults: FilledAttribute[] = [];
  const colorVal = specMap.get("颜色") || specMap.get("Color") || specMap.get("Цвет") || "Черный";
  const materialVal = specMap.get("材质") || specMap.get("Material") || specMap.get("Материал") || "Пластик";
  const sizeVal = specMap.get("尺码") || specMap.get("尺寸") || specMap.get("Size") || "Универсальный";
  const weightVal = specMap.get("重量") || specMap.get("Weight") || specMap.get("Вес") || "0.5";

  // These IDs are placeholder — real IDs come from Ozon's getCategoryAttributes response
  defaults.push({ attributeId: 0, name: "Цвет", value: colorVal });
  defaults.push({ attributeId: 0, name: "Материал", value: materialVal });
  defaults.push({ attributeId: 0, name: "Размер", value: sizeVal });
  defaults.push({ attributeId: 0, name: "Вес", value: weightVal });

  return defaults;
}
