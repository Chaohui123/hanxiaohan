import { readFile } from "node:fs/promises";

export interface CompetitorComparabilityConfig {
  links?: Array<{ offerId: string; competitorUrl: string; comparability?: string; includeInPriceComparison?: boolean }>;
}

export async function loadCompetitorComparability(filePath: string): Promise<CompetitorComparabilityConfig> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as CompetitorComparabilityConfig;
  if (!Array.isArray(parsed.links)) throw new Error("Competitor comparability config is missing links");
  return parsed;
}

export function filterCurrentComparablePrices<T extends { competitorUrl?: string | null }>(
  prices: T[],
  config: CompetitorComparabilityConfig | null,
  offerId: string,
): T[] {
  const directUrls = new Set((config?.links || [])
    .filter((item) => item.offerId === offerId && item.comparability === "direct_comparable" && item.includeInPriceComparison === true)
    .map((item) => item.competitorUrl));
  return prices.filter((item) => directUrls.has(item.competitorUrl || ""));
}
