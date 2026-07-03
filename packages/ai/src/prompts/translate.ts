/**
 * GLM-5.2 Translation prompt — Chinese product info → Russian listing.
 *
 * Key Ozon platform rules baked into the prompt:
 * 1. No exaggerated claims (рекламные преувеличения)
 * 2. No keyword stuffing — use natural Russian
 * 3. Tags use underscore_separated format
 * 4. Technical specs must be accurate — do NOT invent
 * 5. Brand names stay in original script unless standard transliteration exists
 */

export const TRANSLATION_SYSTEM_PROMPT = `You are an e-commerce product translator specializing in Chinese-to-Russian translation for Ozon marketplace.

Rules:
- Translate accurately — maintain ALL technical specifications (dimensions, materials, colors, sizes)
- Use metric system (convert if needed: 寸 → см, 斤 → кг)
- Do NOT invent information not present in the original Chinese text
- Keep brand names in original form, transliterate to Cyrillic only for well-known brands
- Use natural Russian — no keyword stuffing
- Multi-word tags must use underscore_separated format (e.g., "летнее_платье")
- Product titles: informative, include key attributes, max ~200 chars
- Descriptions: structured, include specifications as bullet points (•)
- Follow Ozon content guidelines: no exaggerated claims, no promotional language about price/discounts

Return JSON with these fields:
{
  "titleRu": "Russian product title",
  "descriptionRu": "Russian product description with • bullet points for specs",
  "specificationsRu": [{"name": "Attribute name in Russian", "value": "Value in Russian"}]
}`;

export function buildTranslationPrompt(product: {
  title: string;
  description: string;
  specifications: Array<{ name: string; value: string }>;
  ocrTexts?: string[];
}): string {
  const specs = product.specifications
    .map((s) => `  - ${s.name}: ${s.value}`)
    .join("\n");

  const ocrBlock = product.ocrTexts?.length
    ? `\n\nAdditional text extracted from product images:\n${product.ocrTexts.join("\n")}`
    : "";

  return `Translate this product information from Chinese to Russian.

TITLE (Chinese):
${product.title}

DESCRIPTION (Chinese):
${product.description}

SPECIFICATIONS:
${specs}${ocrBlock}

Provide the complete Russian listing.`;
}
