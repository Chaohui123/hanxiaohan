// Type declarations for modules without @types packages
declare module "opossum" {
  export class CircuitBreaker {
    constructor(fn: (...args: unknown[]) => Promise<unknown>, options?: Record<string, unknown>);
    fire<T>(...args: unknown[]): Promise<T>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    get stats(): { failures: number; successes: number; fallbacks: number };
    opened: boolean;
  }
}

declare module "chrome-remote-interface" {
  const CDP: (opts: { port: number }) => Promise<unknown>;
  export default CDP;
}

declare module "@imgly/background-removal-node" {
  export function removeBackground(
    blob: Blob,
    options?: { model?: string; output?: { format?: string } },
  ): Promise<Blob>;
}
