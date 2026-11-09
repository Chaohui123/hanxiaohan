export interface CompetitorHistoryPoint {
  competitorUrl: string;
  capturedAt: string;
  price: number;
  displayPrice?: number;
  priceRegular?: number | null;
  priceType?: string;
}

export function hasVerifiedRegularPrice(point: CompetitorHistoryPoint): boolean {
  return point.priceType === "regular"
    && Number.isFinite(point.priceRegular)
    && Number(point.priceRegular) > 0
    && point.price === point.priceRegular;
}

export function hasFreshRegularPrice(point: CompetitorHistoryPoint, now = Date.now(), maximumAgeMs = 24 * 3600_000): boolean {
  const capturedTime = new Date(point.capturedAt).getTime();
  const age = now - capturedTime;
  return hasVerifiedRegularPrice(point) && Number.isFinite(capturedTime) && age >= 0 && age <= maximumAgeMs;
}

export function latestByCompetitorUrl<T extends CompetitorHistoryPoint>(prices: T[]): T[] {
  const latest = new Map<string, T>();
  for (const point of prices) {
    if (!point.competitorUrl) continue;
    const current = latest.get(point.competitorUrl);
    if (!current || new Date(point.capturedAt).getTime() > new Date(current.capturedAt).getTime()) latest.set(point.competitorUrl, point);
  }
  return [...latest.values()];
}

export function sharedPriceAverage<T extends CompetitorHistoryPoint>(
  currentPrices: ReadonlyMap<string, number>,
  previous: T[],
): { current: number; previous: number } | null {
  const shared = previous.filter((point) => currentPrices.has(point.competitorUrl));
  if (shared.length === 0) return null;
  return {
    current: shared.reduce((sum, point) => sum + Number(currentPrices.get(point.competitorUrl)), 0) / shared.length,
    previous: shared.reduce((sum, point) => sum + point.price, 0) / shared.length,
  };
}

export function selectPreviousCompetitorPrices<T extends CompetitorHistoryPoint>(
  prices: T[],
  currentCapturedAt: string,
  minimumGapMs = 20 * 3600_000,
): T[] {
  const currentTime = new Date(currentCapturedAt).getTime();
  if (!Number.isFinite(currentTime)) return [];
  const previous = prices.filter((point) => {
    const time = new Date(point.capturedAt).getTime();
    return point.competitorUrl && point.price > 0 && Number.isFinite(time) && time <= currentTime - minimumGapMs;
  });
  if (previous.length === 0) return [];
  const candidates = latestByCompetitorUrl(previous);
  const latest = Math.max(...candidates.map((point) => new Date(point.capturedAt).getTime()));
  return candidates.filter((point) => latest - new Date(point.capturedAt).getTime() <= 6 * 3600_000);
}
