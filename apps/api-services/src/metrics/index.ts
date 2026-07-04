// Prometheus metrics — optional, only loaded when PROMETHEUS_ENABLED=true
// Note: prom-client is NOT installed by default
// Install when enabling metrics: pnpm add prom-client

let loaded = false;
let _register: { metrics: () => Promise<string> } | null = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;

  if (process.env.PROMETHEUS_ENABLED !== "true") return;

  try {
    // @ts-expect-error — prom-client is optional, not installed by default
    _register = await import("prom-client").then(m => m.register);
  } catch {
    // prom-client not installed — metrics disabled
  }
}

// No-op stubs that return safe defaults when prom-client isn't installed
export const requestCounter = { inc: () => {} };
export const requestDuration = { observe: () => {} };
export const taskCounter = { inc: () => {} };
export const taskDuration = { observe: () => {} };
export const activeWorkers = { set: () => {} };
export const queueSize = { set: () => {} };
export const tokenUsage = { inc: () => {} };
export const errorCounter = { inc: () => {} };
export const circuitBreakerState = { set: () => {} };

export async function collectMetrics(): Promise<string> {
  await ensureLoaded();
  if (!_register) return "";
  return _register.metrics();
}

export function getMetrics() {
  return [];
}
