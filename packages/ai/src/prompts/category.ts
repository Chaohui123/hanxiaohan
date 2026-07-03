/**
 * GLM-5.2 Category matching prompt.
 * Map a Chinese product to Ozon's 4-level category tree.
 */

export const CATEGORY_SYSTEM_PROMPT = `You are an Ozon category matching specialist.
Given a product description (in Chinese or Russian) and a tree of Ozon categories,
find the most specific matching leaf category.

Rules:
- Match to the MOST SPECIFIC leaf category possible
- Consider the product type, material, use case, target audience
- If uncertain between two categories, pick the more general one and note low confidence
- Category IDs are numbers — return the ID, not the name
- Only return categories that actually exist in the provided tree

Return JSON:
{
  "categoryId": 12345,
  "categoryName": "Full category path",
  "categoryPath": ["Level1", "Level2", "Level3", "Level4"],
  "confidence": 0.85,
  "reasoning": "Brief explanation of why this category was chosen"
}`;

export function buildCategoryPrompt(
  product: { title: string; categoryPath?: string[]; specifications: Array<{ name: string; value: string }> },
  categoryTreePreview: string
): string {
  const specs = product.specifications
    .map((s) => `${s.name}: ${s.value}`)
    .join(", ");

  return `Match this product to the best Ozon category.

PRODUCT:
Title: ${product.title}
${product.categoryPath ? `1688 Category: ${product.categoryPath.join(" > ")}` : ""}
Specifications: ${specs}

OZON CATEGORY TREE (abbreviated):
${categoryTreePreview}

Find the most specific leaf category for this product.`;
}

/**
 * Format a category tree into a compact, readable string for the prompt.
 */
export function formatCategoryTree(
  nodes: Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>,
  depth: number = 0
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes.slice(0, depth === 0 ? 20 : 10)) { // limit breadth
    lines.push(`${indent}[${node.categoryId}] ${node.title}`);
    if (node.children?.length > 0 && depth < 3) {
      // For depth 0-1: show top children; depth 2: limit to 5
      const childrenToShow = depth < 2
        ? node.children
        : node.children.slice(0, 5);
      lines.push(formatCategoryTree(childrenToShow, depth + 1));
    }
  }

  if (nodes.length > (depth === 0 ? 20 : 10)) {
    lines.push(`${indent}... (${nodes.length - (depth === 0 ? 20 : 10)} more)`);
  }

  return lines.join("\n");
}
