// ============================================================
// OpenTelemetry Tracing — distributed tracing via OTLP
// Instruments: Express, HTTP, custom pipeline spans
// Exports to: Jaeger/Tempo via OTLP HTTP
// ============================================================

import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";

let sdk: NodeSDK | null = null;
const tracer = trace.getTracer("onzo-api-services");

/**
 * Initialize OpenTelemetry SDK.
 * Call once at startup. No-op if OTEL_ENABLED !== "true".
 */
export async function initTracing(serviceName = "onzo-api-services"): Promise<void> {
  if (process.env.OTEL_ENABLED !== "true") return;

  try {
    const exporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` })
      : new ConsoleSpanExporter();

    sdk = new NodeSDK({
      resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
      traceExporter: exporter,
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    });

    await sdk.start();
    console.log("[Tracing] OpenTelemetry initialized — exporting to", process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "console");
  } catch (err) {
    console.error("[Tracing] Failed to initialize:", err);
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try { await sdk.shutdown(); } catch {}
}

/**
 * Create a span for a pipeline step. Use as:
 *   const span = startSpan("pipeline.scrape");
 *   try { ... } finally { span.end(); }
 */
export function startSpan(name: string, attrs?: Record<string, string>) {
  const span = tracer.startSpan(name);
  if (attrs) span.setAttributes(attrs);
  return span;
}
