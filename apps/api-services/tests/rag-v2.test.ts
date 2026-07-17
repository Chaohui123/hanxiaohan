// ============================================================
// RAG v2 Tests — chunking, token counting, vector search, fallback
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunkText, estimateChunkCount } from "../src/services/rag-v2/chunker.js";
import { estimateTokens, countMessageTokens, truncateContext } from "../src/services/rag-v2/token-counter.js";

// Mock DB for vector store tests
const mockDb = {
  exec: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue({ changes: 1 }),
  all: vi.fn().mockResolvedValue([]),
};

// Mock embedding client
vi.mock("@onzo/embedding", () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue({ text: "", vector: new Array(2048).fill(0.01), tokenCount: 10 }),
    embedBatch: vi.fn().mockResolvedValue([{ text: "", vector: new Array(2048).fill(0.01), tokenCount: 10 }]),
    getRequestCount: vi.fn().mockReturnValue(0),
  })),
}));

describe("Text Chunker", () => {
  it("returns single chunk for text under 10KB", () => {
    const text = "Short product description. ".repeat(50); // ~2KB
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
  });

  it("splits large text into multiple 10KB chunks", () => {
    const text = "A".repeat(25000); // ~25KB
    const chunks = chunkText(text, { maxChunkBytes: 10240 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("respects custom chunk size", () => {
    const text = "B".repeat(10000);
    const chunks = chunkText(text, { maxChunkBytes: 2048 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it("estimates chunk count correctly", () => {
    const text = "C".repeat(50000);
    const count = estimateChunkCount(text, 10240);
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("splits on paragraph boundaries", () => {
    const text = "Paragraph One Content Here\n\nParagraph Two Content Here\n\nParagraph Three Here";
    const chunks = chunkText(text, { maxChunkBytes: 50, minChunkBytes: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("Token Counter", () => {
  it("estimates English tokens (1 per 4 chars)", () => {
    const tokens = estimateTokens("Hello world test message");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(30);
  });

  it("estimates CJK tokens more densely", () => {
    const engTokens = estimateTokens("Hello world");
    const cjkTokens = estimateTokens("你好世界测试");
    expect(cjkTokens).toBeGreaterThan(0);
  });

  it("counts message tokens including framing overhead", () => {
    const msgs = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is the price?" },
    ];
    const tokens = countMessageTokens(msgs);
    expect(tokens).toBeGreaterThan(10);
  });

  it("truncates context to fit max tokens", () => {
    const msgs = [
      { role: "system", content: "System prompt here." },
      { role: "user", content: "Message 1 ".repeat(200) },
      { role: "user", content: "Message 2 ".repeat(200) },
      { role: "assistant", content: "Response ".repeat(200) },
    ];
    const truncated = truncateContext(msgs, 500);
    expect(countMessageTokens(truncated)).toBeLessThanOrEqual(550); // ~10% margin
  });

  it("preserves system prompt when truncating", () => {
    const msgs = [
      { role: "system", content: "IMPORTANT SYSTEM RULES" },
      { role: "user", content: "Long message ".repeat(500) },
    ];
    const truncated = truncateContext(msgs, 200);
    expect(truncated[0]?.role).toBe("system");
    expect(truncated[0]?.content).toBe("IMPORTANT SYSTEM RULES");
  });
});

describe("Vector Store", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("initializes schema on first use", async () => {
    const { SqliteVectorStore } = await import("../src/services/rag-v2/sqlite-store.js");
    const store = new SqliteVectorStore(mockDb as any);
    await store.initSchema();
    expect(mockDb.exec).toHaveBeenCalled();
  });

  it("inserts and searches documents", async () => {
    const { SqliteVectorStore } = await import("../src/services/rag-v2/sqlite-store.js");
    const store = new SqliteVectorStore(mockDb as any);
    await store.insert({
      id: "test-1", collection: "success_copy",
      content: "Test product listing",
      metadata: { sourceUrl: "https://detail.1688.com/test" },
      vector: new Array(2048).fill(0.01),
      tokenCount: 10,
      byteLength: 100,
    });
    expect(mockDb.run).toHaveBeenCalled();
  });
});

describe("RAG v2 Service — fallback on threshold", () => {
  it("returns empty results when RAG_ENABLE=false", async () => {
    process.env.RAG_ENABLE = "false";
    const { RagV2Service } = await import("../src/services/rag-v2/service.js");
    const service = new RagV2Service(mockDb as any);
    const results = await service.search({ collection: "success_copy", query: "test" });
    expect(results).toEqual([]);
    delete process.env.RAG_ENABLE;
  });

  it("returns stats even when store is empty", async () => {
    const { RagV2Service } = await import("../src/services/rag-v2/service.js");
    const service = new RagV2Service(null);
    const stats = service.getStats();
    expect(stats.enabled).toBe(false);
    expect(stats.store).toBe("none");
    expect(stats.totalDocs).toBe(0);
  });
});