// ============================================================
// Anti-detection measures for 1688 scraping
// ============================================================

/**
 * Pool of modern Chrome user-agent strings for rotation.
 */
export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
];

/**
 * Common viewport sizes for desktop Chrome.
 */
export const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
];

/**
 * Get a random element from an array.
 */
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Get a random delay between min and max (in ms).
 */
export function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a fresh stealth configuration for each browser context.
 * Called per-context to rotate fingerprints.
 */
export function createStealthConfig() {
  return {
    userAgent: randomPick(USER_AGENTS),
    viewport: randomPick(VIEWPORTS),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    geolocation: { latitude: 30.2741, longitude: 120.1551 },
    permissions: ["geolocation"],
    colorScheme: "light" as const,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  };
}

/**
 * @deprecated Use createStealthConfig() for per-context rotation.
 * Kept for backward compatibility.
 */
export const STEALTH_CONFIG = createStealthConfig();
