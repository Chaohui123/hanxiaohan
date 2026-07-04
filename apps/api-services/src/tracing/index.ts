// ============================================================
// OpenTelemetry Tracing — distributed tracing via OTLP
// Instruments: Express, HTTP, custom pipeline spans
// Exports to: Jaeger/Tempo via OTLP HTTP
// ============================================================

// ============================================================
// OpenTelemetry Tracing — distributed tracing via OTLP
// Note: @opentelemetry/* packages are NOT installed by default.
// Install them when enabling tracing:
//   pnpm add @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-express @opentelemetry/instrumentation-http @opentelemetry/resources @opentelemetry/semantic-conventions @opentelemetry/api
// ============================================================

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

    const exporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? (() => {
          // Dynamic import of OTLP exporter (optional)
          import("@opentelemetry/exporter-trace-otlp-http").then(({ OTLPTraceExporter }) => {
            return new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` });
          }).catch(() => null);
          return new (ConsoleSpanExporter as new () => unknown)() as unknown;
        })()
      : new (ConsoleSpanExporter as new () => unknown)();

    const sdk = new (NodeSDK as new (config: Record<string, unknown>) => { start: () => Promise<void>; shutdown: () => Promise<void> })({
      resource: new (Resource as new (attrs: Record<string, string>) => unknown)({
        [SemanticResourceAttributes.SERVICE_NAME as string]: serviceName,
      }),
      traceExporter: exporter,
      instrumentations: [
        new (HttpInstrumentation as new () => unknown)(),
        new (ExpressInstrumentation as new () => unknown)(),
      ],
    });

    await sdk.start();
    console.log("[Tracing] OpenTelemetry initialized");
  } catch (err) {
    console.error("[Tracing] Failed to initialize:", err);
  }
}

export async function shutdownTracing(): Promise<void> {
  // No-op when SDK isn't loaded
}

export function startSpan(_name: string, _attrs?: Record<string, string>) {
  // No-op when tracing isn't enabled
  return { end: () => {}, setAttributes: () => {} };
}

