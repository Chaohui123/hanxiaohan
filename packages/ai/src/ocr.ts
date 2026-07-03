// ============================================================
// Vision Client — GLM-4.6V-Flash for product image OCR
// ============================================================

import type { OcrResult } from "@onzo/shared-types";
import { GlmClient, type GlmClientConfig } from "./glm-client.js";
import { OCR_SYSTEM_PROMPT, OCR_USER_PROMPT } from "./prompts/ocr.js";

export type ImageInput = { url: string } | { base64: string; mimeType: string };

export class GlmVisionClient {
  private client: GlmClient;
  private model: string;

  constructor(config: GlmClientConfig & { model?: string }) {
    this.client = new GlmClient(config);
    this.model = config.model ?? "glm-4v-flash";
  }

  /**
   * OCR on a single product image.
   */
  async extractTextFromImage(imageInput: ImageInput): Promise<OcrResult> {
    const imageBlock = "url" in imageInput
      ? { type: "image_url" as const, image_url: { url: imageInput.url } }
      : { type: "image_url" as const, image_url: { url: `data:${imageInput.mimeType};base64,${imageInput.base64}` } };

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
      temperature: 0.1,
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
   * Use GlmRateLimiter wrapper to enforce rate limits.
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
          results.push({
            rawText: `OCR failed: ${result.reason?.message ?? "unknown error"}`,
            structured: {},
          });
        }
      }
    }

    return results;
  }
}
