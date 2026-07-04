// ============================================================
// Return Risk Analyzer — predict product return probability
// Uses category + product attributes to estimate return risk
// ============================================================

export interface ReturnRiskResult {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskScore: number;
  estimatedReturnRate: number;
  reasons: string[];
  recommendations: string[];
}

const HIGH_RETURN_CATEGORIES: Record<string, number> = {
  footwear: 0.25,
  clothing: 0.22,
  electronics: 0.12,
  accessories: 0.08,
  default: 0.10,
};

const PRIORITY_CATEGORIES: Record<string, number> = {
  auto_parts: 0.04,
  tools: 0.05,
  home_storage: 0.06,
  hardware: 0.03,
};

export function analyzeReturnRisk(params: {
  category?: string;
  productType?: string;
  hasSizeVariants?: boolean;
  hasColorVariants?: boolean;
  isElectronic?: boolean;
}): ReturnRiskResult {
  const category = params.category || "default";
  const reasons: string[] = [];
  const recommendations: string[] = [];

  let baseReturnRate = HIGH_RETURN_CATEGORIES[category] ?? HIGH_RETURN_CATEGORIES.default;
  let riskLevel: ReturnRiskResult["riskLevel"] = "LOW";
  let riskScore = 0;

  // Check if category is a known high-return category
  const matchedHighReturn = Object.keys(HIGH_RETURN_CATEGORIES).find((k) =>
    category.toLowerCase().includes(k)
  );

  if (matchedHighReturn) {
    const rate = HIGH_RETURN_CATEGORIES[matchedHighReturn];
    if (rate >= 0.20) {
      riskLevel = "CRITICAL";
      reasons.push(`Category "${matchedHighReturn}" has high return rate of ${Math.round(rate * 100)}%`);
      recommendations.push("Strongly recommend avoiding this category");
      recommendations.push("Consider products without sizing/fit issues");
    } else {
      riskLevel = "HIGH";
      reasons.push(`Category "${matchedHighReturn}" has return rate ~${Math.round(rate * 100)}%`);
      recommendations.push("Provide detailed sizing charts and measurement guide");
    }
    riskScore = Math.round(rate * 100);
  }

  // Priority categories (low risk)
  const matchedPriority = Object.keys(PRIORITY_CATEGORIES).find((k) =>
    category.toLowerCase().includes(k)
  );
  if (matchedPriority) {
    const priorityRate = PRIORITY_CATEGORIES[matchedPriority];
    riskScore = Math.round(priorityRate * 100);
    riskLevel = "LOW";
    reasons.push(`Priority category "${matchedPriority}" has only ${Math.round(priorityRate * 100)}% return rate`);
    recommendations.push("Good for cross-border — low return risk");
  }

  // Size variants increase return risk
  if (params.hasSizeVariants) {
    riskScore += 10;
    reasons.push("Product has size variants — increases return risk");
    recommendations.push("Include Russian size conversion chart in description");
  }

  // Color variants slightly increase risk
  if (params.hasColorVariants) {
    riskScore += 3;
    reasons.push("Color variants may cause minor mismatch expectations");
  }

  // Electronics have additional failure risk
  if (params.isElectronic) {
    riskScore += 8;
    reasons.push("Electronics have functional failure return risk");
    recommendations.push("Include clear voltage/plug compatibility info for Russia (220V)");
  }

  // Final risk level
  if (riskScore >= 25) riskLevel = "CRITICAL";
  else if (riskScore >= 15) riskLevel = "HIGH";
  else if (riskScore >= 8) riskLevel = "MEDIUM";

  return {
    riskLevel,
    riskScore,
    estimatedReturnRate: Math.round(baseReturnRate * 100) / 100,
    reasons,
    recommendations,
  };
}
