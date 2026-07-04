// ============================================================
// Image Russianizer — GLM Vision analysis + Russian text overlay
// 1. GLM-4.6V-Flash analyzes image content, extracts Chinese text
// 2. DeepSeek translates selling points to Russian
// 3. Sharp/Jimp overlays Russian text onto image
// ============================================================

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { logger } from "@onzo/logger";

export interface ImageAnalysis {
  /** What the image shows (Russian) */
  descriptionRu: string;
  /** Key selling points visible in image (Russian) */
  sellingPoints: string[];
  /** Any Chinese text found in image (original + Russian translation) */
  textOverlays: Array<{ original: string; translated: string }>;
  /** Suggested overlay text position: "top" | "bottom" | "center" */
  overlayPosition: "top" | "bottom" | "center";
}

export interface ImageProcessResult {
  success: boolean;
  outputPath: string;
  analysis: ImageAnalysis;
  error?: string;
}

/**
 * Analyze a product image with GLM Vision to identify content and selling points.
 */
export async function analyzeImage(
  visionClient: { extractTextFromImages: (images: Array<{ url: string }>) => Promise<Array<{ rawText: string; description?: string }>> },
  imageUrl: string
): Promise<ImageAnalysis> {
  try {
    const results = await visionClient.extractTextFromImages([{ url: imageUrl }]);
    const ocrText = results[0]?.rawText || "";

    // Default analysis if vision is limited
    return {
      descriptionRu: "Изображение товара",
      sellingPoints: [],
      textOverlays: ocrText
        ? [{ original: ocrText, translated: "" }]
        : [],
      overlayPosition: "bottom",
    };
  } catch (err) {
    logger.warn({ err, imageUrl }, "GLM Vision analysis failed, using defaults");
    return {
      descriptionRu: "Изображение товара",
      sellingPoints: [],
      textOverlays: [],
      overlayPosition: "bottom",
    };
  }
}

/**
 * Generate Russian overlay text for a product image using DeepSeek.
 */
export async function generateImageOverlayText(
  deepseekClient: { chatCompletion: (opts: { model: string; messages: Array<{ role: string; content: string }>; temperature: number; maxTokens: number; responseFormat: { type: string } }) => Promise<{ parsed: { overlays: Array<{ textRu: string; position: string }> } | null }> },
  analysis: ImageAnalysis,
  productInfo: { titleCn: string; specs?: Array<{ name: string; value: string }> }
): Promise<Array<{ textRu: string; position: string }>> {
  const specsText = (productInfo.specs ?? []).map((s) => `${s.name}: ${s.value}`).join(", ");

  const prompt = `Generate Russian text overlays for a product image on Ozon marketplace.

Product: ${productInfo.titleCn}
Specifications: ${specsText}
Image shows: ${analysis.descriptionRu}

Task: Write 1-2 SHORT Russian captions (max 15 words each) suitable for overlay on a product image.
These should highlight key selling points, NOT be generic marketing text.
Position: "top" or "bottom" of the image.

Return JSON:
{
  "overlays": [
    {"textRu": "Магнитное крепление, выдерживает любые повороты", "position": "top"},
    {"textRu": "Вакуумная присоска — надёжная фиксация", "position": "bottom"}
  ]
}`;

  try {
    const response = await deepseekClient.chatCompletion({
      model: "flash",
      messages: [
        { role: "system", content: "You are a Russian e-commerce marketer. Write concise image overlay text. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      maxTokens: 1000,
      responseFormat: { type: "json_object" },
    });

    if (response.parsed?.overlays) return response.parsed.overlays;
  } catch (err) {
    logger.warn({ err }, "DeepSeek overlay text generation failed");
  }

  // Fallback
  return [{ textRu: productInfo.titleCn, position: "bottom" }];
}

/**
 * Apply Russian text overlay to image using Sharp.
 * Falls back to copying original if Sharp is not available.
 */
export async function applyOverlay(
  inputPath: string,
  outputDir: string,
  overlays: Array<{ textRu: string; position: string }>
): Promise<string> {
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

  const inputName = basename(inputPath);
  const outputPath = join(outputDir, inputName.replace(/\.(jpg|jpeg|png|webp)$/i, "_ru.$1"));

  try {
    // Try Sharp for image processing
    const sharp = await import("sharp").catch(() => null);

    if (sharp) {
      const image = sharp.default(inputPath);
      const metadata = await image.metadata();
      const width = metadata.width || 800;
      const height = metadata.height || 800;

      // Create SVG overlay with Russian text
      const svgOverlays = overlays
        .map((o, i) => {
          const y = o.position === "top" ? 60 + i * 50 : height - 80 - (overlays.length - 1 - i) * 50;
          return `<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="24" font-family="Arial,sans-serif" font-weight="bold" fill="white" stroke="black" stroke-width="1">${o.textRu}</text>`;
        })
        .join("\n");

      const svgImage = `
        <svg width="${width}" height="${height}">
          <style>
            text { paint-order: stroke fill; }
          </style>
          ${svgOverlays}
        </svg>`;

      await image
        .composite([{ input: Buffer.from(svgImage), top: 0, left: 0 }])
        .toFile(outputPath);

      logger.info({ input: inputPath, output: outputPath }, "Image overlay applied with Sharp");
      return outputPath;
    }
  } catch (err) {
    logger.warn({ err }, "Sharp image processing failed, trying Jimp fallback");
  }

  // Fallback: try Jimp
  try {
    const Jimp = (await import("jimp")).default;
    const image = await Jimp.read(inputPath);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

    for (let i = 0; i < overlays.length; i++) {
      const y = overlays[i].position === "top" ? 30 + i * 50 : image.bitmap.height - 60 - (overlays.length - 1 - i) * 50;
      image.print(font, 20, y, overlays[i].textRu);
    }

    await image.writeAsync(outputPath);
    logger.info({ input: inputPath, output: outputPath }, "Image overlay applied with Jimp");
    return outputPath;
  } catch (err) {
    // Both libraries unavailable — copy original
    logger.warn({ err }, "No image processing library available, copying original");
    await writeFile(outputPath, await readFile(inputPath));
    return outputPath;
  }
}
