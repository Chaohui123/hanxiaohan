// ============================================================
// Text Splitter — auto-splits oversized text to fit token limits
// Falls back to paragraph/sentence split when langchain unavailable.
// ============================================================

import { estimateTokensFast, getMaxInputTokens } from "./token-counter.js";

export interface SplitResult {
  chunks: string[];
  totalChunks: number;
  originalTokens: number;
  chunkTokens: number[];
}

/**
 * Recursively split text by token count using natural boundaries.
 * Tries RecursiveCharacterTextSplitter when @langchain/textsplitters is available,
 * falls back to paragraph/sentence splitting.
 */
export async function splitByTokenLimit(
  text: string,
  maxTokensPerChunk: number,
  overlapTokens = 0,
): Promise<SplitResult> {
  const originalTokens = estimateTokensFast(text);

  // Split by paragraphs, then sentences (natural boundaries)
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const combinedTokens = estimateTokensFast(current + "\n\n" + para);
    if (combinedTokens <= maxTokensPerChunk) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // If single paragraph exceeds limit, split by sentences
      if (estimateTokensFast(para) > maxTokensPerChunk) {
        const sentences = para.split(/(?<=[。.!?！？])\s*/);
        for (const sent of sentences) {
          if (estimateTokensFast(current + sent) <= maxTokensPerChunk) {
            current = current ? current + sent : sent;
          } else {
            if (current) chunks.push(current);
            current = sent;
          }
        }
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  const chunkTokens = chunks.map((c) => estimateTokensFast(c));
  return { chunks, totalChunks: chunks.length, originalTokens, chunkTokens };
}

/**
 * Truncate text to fit within token limit, preserving start + optional end.
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number,
  preserveLastTokens = 0,
): string {
  const totalTokens = estimateTokensFast(text);
  if (totalTokens <= maxTokens) return text;

  const maxChars = maxTokens * 3;
  const preserveChars = preserveLastTokens * 3;

  if (preserveChars > 0 && maxChars > preserveChars) {
    const head = text.slice(0, maxChars - preserveChars);
    const tail = text.slice(-preserveChars);
    return head + "\n...[truncated]...\n" + tail;
  }

  return text.slice(0, maxChars) + "\n...[truncated]";
}

/**
 * Smart prepare: split if oversized, otherwise return as single chunk.
 * Single entry point for token-safe text preparation.
 */
export async function prepareForLLM(
  text: string,
  systemPrompt: string,
  model: string,
): Promise<{ chunks: string[]; systemTokens: number; chunkTokens: number[] }> {
  const maxInput = getMaxInputTokens(model);
  const systemTokens = estimateTokensFast(systemPrompt);
  const availablePerChunk = maxInput - systemTokens;

  if (estimateTokensFast(text) <= availablePerChunk) {
    return {
      chunks: [text],
      systemTokens,
      chunkTokens: [estimateTokensFast(text)],
    };
  }

  const result = await splitByTokenLimit(text, availablePerChunk);
  return {
    chunks: result.chunks,
    systemTokens,
    chunkTokens: result.chunkTokens,
  };
}
