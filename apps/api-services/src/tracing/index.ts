// ============================================================
// OpenTelemetry Tracing — distributed tracing via OTLP HTTP
// Instruments Express + HTTP automatically.
// Exports to Jaeger/Tempo when OTEL_ENABLED=true.
// ============================================================

import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace, Span, SpanStatusCode } from "@opentelemetry/api";

let sdk: NodeSDK | null = null;
const otelTracer = trace.getTracer("onzo-api-services");

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
    console.log("[Tracing] OpenTelemetry initialized — endpoint:", process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "console");
  } catch (err) {
    console.error("[Tracing] Failed to initialize:", err);
  }
}

/**
 * Shutdown the SDK gracefully.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    console.log("[Tracing] Shutdown complete");
  } catch (err) {
    console.error("[Tracing] Shutdown error:", err);
  }
}

/**
 * Start a manual span for a pipeline step.
 * Use: const span = startSpan("pipeline.scrape"); try { ... } finally { span.end(); }
 */
export function startSpan(name: string, attrs?: Record<string, string>): Span {
  const span = otelTracer.startSpan(name);
  if (attrs) span.setAttributes(attrs);
  return span;
}

/**
 * Record an error on a span and end it.
 */
export function recordSpanError(span: Span, error: Error): void {
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
}
