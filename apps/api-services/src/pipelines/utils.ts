export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  taskName: string
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${taskName} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([fn(), timeout]);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function exponentialBackoff(attempt: number, baseMs: number = 1000): number {
  return baseMs * Math.pow(2, attempt);
}