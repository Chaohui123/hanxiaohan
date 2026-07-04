/**
 * Ozon Category Matching Prompt — strict output constraints.
 * Forces valid numeric ID from the category tree; blocks 0/null.
 */

export const CATEGORY_SYSTEM_PROMPT = `You are an Ozon category matching specialist.
Given a product and an Ozon category tree with numeric IDs, find the best match.

CRITICAL RULES (violations are fatal):
1. categoryId MUST be a number from the tree, EXACTLY as shown in [brackets].
   - Example: if you see "[17027486] Electronics", then categoryId = 17027486.
   - DO NOT guess, fabricate, or return 0. Copy the ID verbatim.
2. If you cannot find any matching category, set confidence=0 and explain why.
   Even then, categoryId MUST be a real ID from the tree — pick the closest ancestor.
3. The tree shows IDs in format: [ID] Name. Use the ID, not the name.
4. Prefer the most specific leaf category that matches the product.

Return this EXACT JSON structure (no extra fields):
{
  "categoryId": 17027486,
  "categoryName": "Full path from tree",
  "categoryPath": ["Level1", "Level2", "Level3"],
  "confidence": 0.85,
  "reasoning": "Brief reason"
}`;

export function buildCategoryPrompt(
  product: { title: string; categoryPath?: string[]; specifications: Array<{ name: string; value: string }> },
  categoryTreePreview: string
): string {
  const specs = product.specifications.map((s) => `${s.name}: ${s.value}`).join(", ");

  return `Match this product to an Ozon category from the tree below.

PRODUCT:
Title: ${product.title}
${product.categoryPath ? `1688 Category: ${product.categoryPath.join(" > ")}` : ""}
Specs: ${specs}

OZON CATEGORY TREE:
${categoryTreePreview}

IMPORTANT: The number in [brackets] before each category name IS the categoryId.
Copy it exactly. Do NOT return 0. If uncertain, pick the closest match from the tree.`;
}

/**
 * Format category tree for prompt — compact, with IDs clearly marked.
 * Shows level-1 and level-2 categories broadly, limits at depth 3+.
 */
export function formatCategoryTree(
  nodes: Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>,
  depth: number = 0
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  const limit = depth <= 1 ? 30 : depth === 2 ? 15 : 5;

  for (const node of nodes.slice(0, limit)) {
    lines.push(`${indent}[${node.categoryId}] ${node.title}`);
    if (node.children?.length > 0 && depth < 3) {
      const childrenToShow = depth < 2 ? node.children : node.children.slice(0, 5);
      lines.push(formatCategoryTree(childrenToShow, depth + 1));
    }
  }

  if (nodes.length > limit) {
    lines.push(`${indent}... (${nodes.length - limit} more categories omitted)`);
  }

  return lines.join("\n");
}

/**
 * Pre-filter the Ozon category tree to only relevant branches based on
 * product keywords. This drastically reduces the tree size sent to the LLM
 * and prevents hallucinated category IDs.
 */
export function filterCategoryTree(
  nodes: Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>,
  keywords: string[]
): Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }> {
  if (!keywords.length || keywords.every((k) => k.length < 2)) return nodes;

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  function matchesKeyword(title: string | undefined): boolean {
    if (!title) return false;
    const lower = title.toLowerCase();
    return lowerKeywords.some((kw) => lower.includes(kw));
  }

  function filterChildren(
    children: Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }>
  ): Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }> {
    const results: Array<{ categoryId: number; title: string; children: Array<{ categoryId: number; title: string; children: unknown[] }> }> = [];
    for (const node of children) {
      const selfMatch = matchesKeyword(node.title);
      const filteredChildren = node.children?.length ? filterChildren(node.children) : [];

      if (selfMatch || filteredChildren.length > 0) {
        results.push({
          categoryId: node.categoryId,
          title: node.title,
          children: filteredChildren.length > 0 ? filteredChildren : node.children,
        });
      }
    }
    return results;
  }

  const filtered = filterChildren(nodes);

  // If filtering removed everything, return original (don't send empty tree)
  if (filtered.length === 0) return nodes;

  return filtered;
}
