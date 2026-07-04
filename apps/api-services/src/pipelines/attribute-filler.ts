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

// Common Ozon attribute name keywords for Russian/Chinese/English matching
// Actual IDs come from Ozon's getCategoryAttributes API — never hardcoded to 0

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
 * Matches against Ozon's requiredAttributes to use real attribute IDs.
 */
export function buildDefaultAttributes(
  product: { title: string; specifications: Array<{ name: string; value: string }> },
  requiredAttributes?: OzonAttribute[]
): FilledAttribute[] {
  const specMap = new Map<string, string>();
  for (const s of product.specifications) specMap.set(s.name, s.value);

  const defaults: FilledAttribute[] = [];
  const colorVal = specMap.get("颜色") || specMap.get("Color") || specMap.get("Цвет") || "Черный";
  const materialVal = specMap.get("材质") || specMap.get("Material") || specMap.get("Материал") || "Пластик";
  const sizeVal = specMap.get("尺码") || specMap.get("尺寸") || specMap.get("Size") || "Универсальный";
  const weightVal = specMap.get("重量") || specMap.get("Weight") || specMap.get("Вес") || "0.5";

  const fallbackMap: Array<{ keywords: string[]; value: string }> = [
    { keywords: ["цвет", "color", "颜色"], value: colorVal },
    { keywords: ["материал", "material", "材质"], value: materialVal },
    { keywords: ["размер", "size", "尺码", "尺寸"], value: sizeVal },
    { keywords: ["вес", "weight", "重量"], value: weightVal },
  ];

  // Match against real Ozon attribute IDs when available
  for (const fb of fallbackMap) {
    let attrId = 0;
    let attrName = fb.keywords[0];

    if (requiredAttributes && requiredAttributes.length > 0) {
      const matched = requiredAttributes.find((a) =>
        fb.keywords.some((kw) => a.name.toLowerCase().includes(kw))
      );
      if (matched) {
        attrId = matched.id;
        attrName = matched.name;
        // If dictionary exists, try to match the value against it
        if (matched.dictionary?.length) {
          const dictMatch = matched.dictionary.find(
            (d) => d.value.toLowerCase() === fb.value.toLowerCase()
          );
          if (dictMatch) {
            defaults.push({ attributeId: attrId, name: attrName, value: dictMatch.value });
            continue;
          }
          // Use first dictionary value as fallback
          defaults.push({ attributeId: attrId, name: attrName, value: matched.dictionary[0].value });
          continue;
        }
      }
    }

    // Only add if we have a real attribute ID (skip 0 — Ozon rejects it)
    if (attrId > 0) {
      defaults.push({ attributeId: attrId, name: attrName, value: fb.value });
    }
  }

  return defaults;
}
