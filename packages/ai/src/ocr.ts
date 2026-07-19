// ============================================================
// Vision OCR Client — Kimi K3 for product image OCR
// The GLM vision path has been removed; GlmClient is retained
// for text/embedding backup only. Export surface is unchanged
// (GlmVisionClient kept as an alias) so the business layer
// requires zero changes.
// ============================================================

import type { OcrResult } from "@onzo/shared-types";
import { KimiVisionClient, type KimiVisionClientConfig } from "./kimi-vision-client.js";
import { OCR_SYSTEM_PROMPT, OCR_USER_PROMPT } from "./prompts/ocr.js";

export type ImageInput = { url: string } | { base64: string; mimeType: string };

/**
 * The Kimi endpoint rejects external image URLs ("unsupported image url"),
 * so {url} inputs must be downloaded server-side and sent as base64.
 * 1688/CDN images need a Referer header to bypass hotlink protection.
 */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

async function downloadAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: "https://detail.1688.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!resp.ok) throw new Error(`image download failed: HTTP ${resp.status}`);
    const mimeType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > IMAGE_MAX_BYTES) {
      throw new Error(`image too large: ${buf.length} bytes > ${IMAGE_MAX_BYTES}`);
    }
    return { base64: buf.toString("base64"), mimeType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legacy callers pass a full endpoint (".../chat/completions") as baseUrl
 * (the old GlmClient fetched it directly). KimiVisionClient expects the API
 * root and appends /chat/completions itself — strip it here.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/chat\/completions\/?$/, "");
}

export class KimiOcrClient {
  private client: KimiVisionClient;
  private model: string;

  constructor(config: KimiVisionClientConfig) {
    this.client = new KimiVisionClient({
      ...config,
      baseUrl: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
    });
    this.model = config.model ?? "kimi-k3";
  }

  /**
   * OCR on a single product image.
   */
  async extractTextFromImage(imageInput: ImageInput): Promise<OcrResult> {
    // The Kimi endpoint rejects external image URLs — always send base64.
    const resolved = "url" in imageInput
      ? await downloadAsBase64(imageInput.url)
      : imageInput;
    const imageBlock = {
      type: "image_url" as const,
      image_url: { url: `data:${resolved.mimeType};base64,${resolved.base64}` },
    };

    const response = await this.client.chatCompletion<OcrResult>({
      model: this.model,
      messages: [
        { role: "system", content: OCR_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            imageBlock,
            { type: "text", text: OCR_USER_PROMPT },
          ],
        },
      ],
      temperature: 1, // K3 currently rejects any temperature other than 1
      responseFormat: { type: "json_object" },
    });

    if (response.parsed) {
      return response.parsed;
    }

    // Fallback: return raw text
    return {
      rawText: response.content,
      structured: {},
    };
  }

  /**
   * Batch OCR on multiple product images.
   * Processes in batches of `concurrency` for speed.
   * Wrap with the shared rate limiter to enforce upstream QPS limits.
   */
  async extractTextFromImages(
    imageInputs: ImageInput[],
    concurrency: number = 3
  ): Promise<OcrResult[]> {
    const results: OcrResult[] = [];

    // Process in batches of `concurrency`
    for (let i = 0; i < imageInputs.length; i += concurrency) {
      const batch = imageInputs.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((input) => this.extractTextFromImage(input))
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const reason = result.reason as Error | undefined;
          results.push({
            rawText: `OCR failed: ${reason?.message ?? "unknown error"}`,
            structured: {},
          });
        }
      }
    }

    return results;
  }
}

/**
 * @deprecated OCR now runs on Kimi K3 (KimiOcrClient).
 * Alias kept so existing business-layer imports keep working unchanged.
 */
export { KimiOcrClient as GlmVisionClient };
