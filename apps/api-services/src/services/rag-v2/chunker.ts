// ============================================================
// Text Chunker — configurable KB-sized chunks with overlap
// Default 10KB chunks, paragraph-aware splitting
// ============================================================

export interface ChunkConfig {
  maxChunkBytes: number;    // default 10240 (10KB)
  overlapBytes: number;     // default 512
  minChunkBytes: number;    // default 256 — don't split if smaller
}

const DEFAULT_CONFIG: ChunkConfig = {
  maxChunkBytes: 10240,
  overlapBytes: 512,
  minChunkBytes: 256,
};

/**
 * Split text into chunks of ~maxChunkBytes.
 * Splits on paragraph boundaries (\n\n) first, then sentence (。.), then word.
 */
export function chunkText(text: string, config: Partial<ChunkConfig> = {}): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { maxChunkBytes, overlapBytes, minChunkBytes } = cfg;

  if (Buffer.byteLength(text, "utf-8") <= minChunkBytes) return [text];

  // Step 1: split by paragraphs
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const paraSize = Buffer.byteLength(para, "utf-8");

    if (paraSize > maxChunkBytes) {
      // Flush current chunk
      if (current) { chunks.push(current.trim()); current = ""; }
      // Split large paragraph by sentences
      const subChunks = splitBySentences(para, maxChunkBytes, overlapBytes);
      chunks.push(...subChunks);
      continue;
    }

    const combinedSize = Buffer.byteLength(current, "utf-8") + paraSize;
    if (combinedSize > maxChunkBytes && current) {
      chunks.push(current.trim());
      // Overlap: keep last `overlapBytes` worth of text
      current = overlapBytes > 0 ? current.slice(-overlapBytes) : "";
    }
    current += (current ? "\n\n" : "") + para;
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text];
}

/** Split a single large paragraph into sentence-level chunks */
function splitBySentences(text: string, maxBytes: number, overlap: number): string[] {
  const sentences = text.split(/(?<=[。.!?！？\n])\s*/);
  const chunks: string[] = [];
  let current = "";

  for (const sent of sentences) {
    const sentSize = Buffer.byteLength(sent, "utf-8");
    if (sentSize > maxBytes) {
      // Sentence itself is too large — force split by fixed size
      if (current) { chunks.push(current.trim()); current = ""; }
      for (let i = 0; i < sent.length; i += Math.floor(maxBytes / 2)) {
        chunks.push(sent.slice(i, i + Math.floor(maxBytes / 2)));
      }
      continue;
    }
    if (Buffer.byteLength(current, "utf-8") + sentSize > maxBytes && current) {
      chunks.push(current.trim());
      current = overlap > 0 ? current.slice(-overlap) : "";
    }
    current += sent;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Estimate number of chunks without actually splitting */
export function estimateChunkCount(text: string, maxChunkBytes = 10240): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf-8") / maxChunkBytes));
}