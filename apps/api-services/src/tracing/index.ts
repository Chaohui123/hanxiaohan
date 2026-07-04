// OpenTelemetry tracing — optional, only loaded when OTEL_ENABLED=true
// Note: @opentelemetry/* packages are NOT installed by default
// Install them only when enabling distributed tracing in production:
//   pnpm add @opentelemetry/sdk-node @opentelemetry/sdk-trace-base \
//            @opentelemetry/instrumentation-express @opentelemetry/instrumentation-http \
//            @opentelemetry/resources @opentelemetry/semantic-conventions

let sdk: unknown = null;
let initialized = false;

export async function initTracing(serviceName = "onzo-api-services"): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (process.env.OTEL_ENABLED !== "true") return;

  try {
    const [{ NodeSDK }, { ConsoleSpanExporter }, { ExpressInstrumentation }, { HttpInstrumentation }, { Resource }, { SemanticResourceAttributes }] = await Promise.all([
      // @ts-expect-error — optional packages, not installed by default
      import("@opentelemetry/sdk-node"),
      // @ts-expect-error
      import("@opentelemetry/sdk-trace-base"),
      // @ts-expect-error
      import("@opentelemetry/instrumentation-express"),
      // @ts-expect-error
      import("@opentelemetry/instrumentation-http"),
      // @ts-expect-error
      import("@opentelemetry/resources"),
      // @ts-expect-error
      import("@opentelemetry/semantic-conventions"),
    ]);

    sdk = new (NodeSDK as new (config: Record<string, unknown>) => { start: () => Promise<void>; shutdown: () => Promise<void> })({
      resource: new (Resource as new (attrs: Record<string, string>) => unknown)({
        [SemanticResourceAttributes.SERVICE_NAME as string]: serviceName,
      }),
      traceExporter: new (ConsoleSpanExporter as new () => unknown)(),
      instrumentations: [
        new (HttpInstrumentation as new () => unknown)(),
        new (ExpressInstrumentation as new () => unknown)(),
      ],
    });

    await (sdk as { start: () => Promise<void> }).start();
    console.log("[Tracing] OpenTelemetry initialized");
  } catch (error) {
    console.error("Failed to initialize tracing:", error);
    sdk = null;
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await (sdk as { shutdown: () => Promise<void> }).shutdown();
  } catch {
    // ignore
  }
}
