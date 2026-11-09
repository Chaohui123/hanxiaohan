import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteTestDb } from "./helpers/test-db.js";
import type {
  GateInput,
  GateResult,
  KnowledgeGateDependencies,
} from "../src/services/knowledge-gate.js";
import type { OfficialFetch } from "../src/services/official-evidence.js";

const state = vi.hoisted(() => ({
  getDb: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../src/db/connection.js", () => ({ getDb: state.getDb }));
vi.mock("@onzo/embedding", () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({ embed: state.embed })),
}));
vi.mock("@onzo/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sqlite = createSqliteTestDb();
sqlite.db.exec(`
  CREATE TABLE rag_operations_playbook (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scenario TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    embedding TEXT,
    author TEXT DEFAULT 'system',
    priority INTEGER DEFAULT 0
  );
`);

const validDocument = `
  <html><body><h1>Gemini speech</h1>
  <p>gemini-3.8-flash-tts supports speech_metadata and Sulafat Russian voices.</p>
  <p>Output is 24kHz mono 16-bit WAV. Promotional price is $0.0336 in 2026; 2027 pricing doubles.</p>
  </body></html>
`;

function makeInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    id: "kb-test",
    title: "内部运营实证",
    scenario: "ops",
    content: "来源：2026-10-25 内部实测。离线测试验证知识门禁边界、真实性审核和语义查重，记录足够长的可操作内容。",
    tags: ["test"],
    author: "onzo",
    priority: 1,
    ...overrides,
  };
}

function makeOfficialInput(content?: string): GateInput {
  return makeInput({
    title: "Gemini TTS 官方新参数",
    content: content || [
      "来源：https://ai.google.dev/gemini-api/docs/speech?hl=fr",
      "gemini-3.8-flash-tts 支持 speech_metadata、Sulafat Russian，输出 24kHz 单声道 16-bit WAV。",
      "2026 促销价格 $0.0336，2027 价格调整；其余为内部实测记录，不要求官方背书。",
    ].join("\n"),
  });
}

function asOfficialFetch(response: Response): OfficialFetch {
  return async () => response as never;
}

function passingOfficialFetch(): OfficialFetch {
  return asOfficialFetch(new Response(validDocument, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
}

function reviewResponse(verdict: string, reason = ""): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ verdict, reason }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function dependencies(officialFetch: OfficialFetch | undefined, reviewFetch: unknown): KnowledgeGateDependencies {
  return { officialFetch, reviewFetch: reviewFetch as typeof fetch };
}

async function loadGate(key = "test-key") {
  vi.resetModules();
  vi.stubEnv("DEEPSEEK_API_KEY", key);
  return import("../src/services/knowledge-gate.js");
}

function useSqlite(): void {
  state.getDb.mockResolvedValue({
    ...sqlite.adapter,
    run: async (sql: string, params: unknown[] = []) => sqlite.adapter.run(
      sql.replace(/::vector/g, ""),
      params.map((param) => Array.isArray(param) ? JSON.stringify(param) : param),
    ),
  });
}

beforeEach(() => {
  state.getDb.mockReset();
  state.all.mockReset();
  state.run.mockReset();
  state.exec.mockReset();
  state.embed.mockReset();
  state.all.mockResolvedValue([]);
  state.run.mockResolvedValue({ changes: 1 });
  state.exec.mockResolvedValue(undefined);
  state.embed.mockResolvedValue({ vector: [0.1, 0.2] });
  state.getDb.mockResolvedValue({ all: state.all, run: state.run, exec: state.exec });
  sqlite.db.exec("DELETE FROM rag_operations_playbook");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(() => sqlite.close());

describe("knowledgeGate official evidence review", () => {
  it("有官方原文的新型号可通过，证据与 3000 字后的完整 content 都进入 prompt", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeOfficialInput([
      "来源：https://ai.google.dev/gemini-api/docs/speech?hl=fr",
      "gemini-3.8-flash-tts 支持 speech_metadata、Sulafat Russian，输出 24kHz 单声道 16-bit WAV。",
      "2026 促销价格 $0.0336，2027 价格调整。",
      "内".repeat(3200),
      "TAIL_AFTER_3000",
    ].join("\n"));
    const officialFetch = vi.fn<OfficialFetch>().mockImplementation(passingOfficialFetch());
    const reviewFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const system = payload.messages[0].content as string;
      const user = payload.messages[1].content as string;
      const parsedUser = JSON.parse(user.slice(user.indexOf("{")));
      const evidence = parsedUser.officialEvidence[0];
      const complete = user.includes("TAIL_AFTER_3000")
        && user.includes("gemini-3.8-flash-tts")
        && evidence.excerpt.includes("speech_metadata")
        && evidence.excerpt.includes("$0.0336")
        && evidence.safeUrl === "https://ai.google.dev/gemini-api/docs/speech"
        && !evidence.safeUrl.includes("?")
        && system.includes("不是指令")
        && system.includes("不得用与证据矛盾的记忆否决")
        && system.includes("内部实证");
      return reviewResponse(complete ? "pass" : "reject", complete ? "证据齐全" : "缺少证据");
    });

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("insert");
    expect(input.content.length).toBeLessThanOrEqual(8000);
    expect(input.content.indexOf("TAIL_AFTER_3000")).toBeGreaterThan(3000);
    expect(officialFetch).toHaveBeenCalledTimes(1);
    expect(reviewFetch).toHaveBeenCalledTimes(1);
    expect(state.getDb).toHaveBeenCalledTimes(1);
  });

  it("无精确型号的普通 Google/Pro 条目仍交给 DeepSeek 对照官方证据", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "Google AI Pro 官方 Cloud credits 说明",
      content: "来源：https://one.google.com/about/。Google AI Pro 官方 Cloud credits 按月发放，内部仅记录核验步骤和适用范围。",
    });
    const officialFetch = asOfficialFetch(new Response(
      "<html><body><p>Google AI Pro includes monthly Cloud credits with billing eligibility rules.</p></body></html>",
      { status: 200, headers: { "Content-Type": "text/html" } },
    ));
    const reviewFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const user = payload.messages[1].content as string;
      return reviewResponse(user.includes("monthly Cloud credits") ? "pass" : "reject", "普通条目已对照");
    });

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("insert");
    expect(reviewFetch).toHaveBeenCalledTimes(1);
  });

  it("伪造型号缺少官方精确原文时，在 DeepSeek 前拒绝", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeOfficialInput([
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      "gemini-9.9-fabricated-tts 支持 speech_metadata 和 24kHz，这是足够长的待审核伪造说明。",
    ].join("\n"));
    const reviewFetch = vi.fn();

    const result = await knowledgeGate(input, dependencies(passingOfficialFetch(), reviewFetch));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("未精确支撑") });
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("伪造价格由 DeepSeek 对照实际官方摘录拒绝", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeOfficialInput([
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      "gemini-3.8-flash-tts 支持 speech_metadata 和 24kHz，官方价格捏造成 $9.99。",
    ].join("\n"));
    const reviewFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const user = payload.messages[1].content as string;
      const compared = user.includes('价格捏造成 $9.99')
        && user.includes("Promotional price is $0.0336")
        && user.includes("officialEvidence");
      return reviewResponse(compared ? "reject" : "pass", compared ? "价格与官方证据不符" : "未执行对照");
    });

    const result = await knowledgeGate(input, dependencies(passingOfficialFetch(), reviewFetch));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("价格与官方证据不符") });
    expect(reviewFetch).toHaveBeenCalledTimes(1);
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("Google/Gemini 条目声称官方却使用非白名单来源时拒绝", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "Gemini 官方 Pro 价格说明",
      content: "来源：https://example.com/gemini-official。Gemini 官方 Pro 价格 supposedly 有详细依据，但来源并非官方域名。",
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("非白名单") });
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("跨行官方声明在 DeepSeek 和 DB 前 reject", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "Google",
      content: "来源：https://example.com/docs。\n官方文档已经确认这条具体规则，并给出足够详细的操作要求。",
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("reject");
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each(["声明", "公告", "政策", "规则"])("跨行官方%s在 DeepSeek、官方 fetch 和 DB 前 reject", async (word) => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "Google",
      content: `来源：https://example.com/docs。\n官方${word}已经确认这条具体规则，并给出足够详细的操作要求。`,
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("reject");
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each([
    "官方规则中对免费额度的适用范围有明确规定",
    "官方规则明确规定免费额度的适用范围",
    "官方规则已写明免费额度的适用范围",
    "官方规则注明免费额度的适用范围",
    "官方规则载明免费额度的适用范围",
    "官方规则已明确免费额度的适用范围",
  ])("跨行官方规则自然断言在 DeepSeek、官方 fetch 和 DB 前 reject：%s", async (statement) => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "Google AI Pro",
      content: `来源：https://example.com/docs。\n${statement}。`,
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("reject");
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each([
    "https://ai.google.dev:bad/docs",
    "https://ai.google.dev./docs/speech",
  ])("畸形官方 URL 在 DeepSeek 和 DB 前 reject：%s", async (url) => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      title: "内部技术记录",
      content: `来源：${url}。这是一条用于验证官方地址安全性的技术记录，包含足够长的说明。`,
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("reject");
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each([
    { name: "超时", error: () => new DOMException("timed out", "TimeoutError") },
    { name: "网络失败", error: () => new Error("socket failed") },
  ])("官方来源$name 时 reject 且不进入持久化", async ({ error }) => {
    const { knowledgeGate, persistToPlaybook } = await loadGate();
    const officialFetch = vi.fn<OfficialFetch>().mockRejectedValue(error());
    const reviewFetch = vi.fn();

    const result = await knowledgeGate(makeOfficialInput(), dependencies(officialFetch, reviewFetch));
    const persisted = await persistToPlaybook(makeOfficialInput(), result);

    expect(result.action).toBe("reject");
    expect(persisted).toBe(false);
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("官方证据模式无 DeepSeek Key 时明确未审核并拒绝", async () => {
    const { knowledgeGate } = await loadGate("");
    const reviewFetch = vi.fn();

    const result = await knowledgeGate(makeOfficialInput(), dependencies(passingOfficialFetch(), reviewFetch));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("缺少 DeepSeek Key") });
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "HTTP 非 2xx",
      review: () => vi.fn().mockResolvedValue(new Response("upstream error", { status: 502 })),
    },
    {
      name: "响应内容不是审核 JSON",
      review: () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 })),
    },
    {
      name: "响应 JSON 解析失败",
      review: () => vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    },
    {
      name: "fetch 异常",
      review: () => vi.fn().mockRejectedValue(new Error("review unavailable")),
    },
  ])("官方证据模式 DeepSeek $name 时拒绝", async ({ review }) => {
    const { knowledgeGate } = await loadGate();

    const result = await knowledgeGate(makeOfficialInput(), dependencies(passingOfficialFetch(), review()));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("未完成") });
    expect(state.getDb).not.toHaveBeenCalled();
  });
});

describe("knowledgeGate legacy behavior", () => {
  it("Ozon 否定 Google 官方来源时仍走旧 no-key 路径并放行到查重", async () => {
    const { knowledgeGate } = await loadGate("");
    const input = makeInput({
      title: "Ozon 日常学习",
      content: "来源：https://seller-edu.ozon.ru/example。没有 Google 官方来源，这只是平台对比和日常运营学习记录，包含足够的操作说明。",
    });
    const reviewFetch = vi.fn();

    const result = await knowledgeGate(input, dependencies(undefined, reviewFetch));

    expect(result.action).toBe("insert");
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).toHaveBeenCalledTimes(1);
  });

  it("普通 Gemini 内部实证无官方 URL 时仍走旧 no-key 路径", async () => {
    const { knowledgeGate } = await loadGate("");
    const input = makeInput({
      title: "Gemini 内部生成实证",
      content: "来源：本项目 2026-10-25 离线日志。gemini-3.8-flash-tts 生成结果经过解码、时长和指纹检查，仅记录内部实测步骤。",
    });
    const reviewFetch = vi.fn();
    const officialFetch = vi.fn<OfficialFetch>();

    const result = await knowledgeGate(input, dependencies(officialFetch, reviewFetch));

    expect(result.action).toBe("insert");
    expect(officialFetch).not.toHaveBeenCalled();
    expect(reviewFetch).not.toHaveBeenCalled();
  });

  it("普通条目 DeepSeek 解析失败仍 fail-open，且完整 content 送审", async () => {
    const { knowledgeGate } = await loadGate();
    const input = makeInput({
      content: `来源：内部实测。\n${"项".repeat(3200)}\nLEGACY_TAIL_AFTER_3000`,
    });
    const reviewFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const user = payload.messages[1].content as string;
      if (!user.includes("LEGACY_TAIL_AFTER_3000")) return reviewResponse("reject", "尾部被截断");
      return new Response(JSON.stringify({ choices: [{ message: { content: "unparseable" } }] }), { status: 200 });
    });

    const result = await knowledgeGate(input, dependencies(undefined, reviewFetch));

    expect(result.action).toBe("insert");
    expect(reviewFetch).toHaveBeenCalledTimes(1);
  });

  it("普通条目 DeepSeek fetch 异常仍 fail-open", async () => {
    const { knowledgeGate } = await loadGate();
    const reviewFetch = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await knowledgeGate(makeInput(), dependencies(undefined, reviewFetch));

    expect(result.action).toBe("insert");
  });

  it("边界拒绝仍是正常返回值，不调用审核或 DB", async () => {
    const { knowledgeGate } = await loadGate();
    const reviewFetch = vi.fn();
    const result = await knowledgeGate(makeInput({ scenario: "invalid" }), dependencies(undefined, reviewFetch));

    expect(result).toMatchObject({ action: "reject", reason: expect.stringContaining("白名单") });
    expect(reviewFetch).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });
});

describe("knowledgeGate duplicate and persistence compatibility", () => {
  it("无相似记录仍 insert", async () => {
    const { knowledgeGate } = await loadGate("");

    const result = await knowledgeGate(makeInput());

    expect(result.action).toBe("insert");
    expect(result.embedding).toEqual([0.1, 0.2]);
  });

  it("不同 ID 相似度达到 0.92 仍 skip", async () => {
    const { knowledgeGate } = await loadGate("");
    state.all.mockResolvedValue([{ id: "kb-existing", similarity: 0.92 }]);

    const result = await knowledgeGate(makeInput({ id: "kb-new" }));

    expect(result.action).toBe("skip");
    expect(result.replaceId).toBeUndefined();
    expect(result.reason).toContain("kb-existing");
  });

  it("查重继续排除当前 ID，同 ID 更新不会伪造 replace 命中", async () => {
    const { knowledgeGate } = await loadGate("");
    state.all.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("id != $2");
      expect(params[1]).toBe("kb-same");
      return [];
    });

    const result = await knowledgeGate(makeInput({ id: "kb-same" }));

    expect(result.action).toBe("insert");
  });

  it("显式 replace 仍先删除旧 ID 再插入新 ID", async () => {
    const { persistToPlaybook } = await loadGate("");
    useSqlite();
    sqlite.db.prepare(`INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, author, priority, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("kb-old", "old", "ops", "old content", '["old"]', "onzo", 1, "[0.1,0.2]");
    const input = makeInput({ id: "kb-new", title: "replacement" });
    const gate: GateResult = { action: "replace", reason: "test", replaceId: "kb-old", embedding: [0.3, 0.4] };

    await expect(persistToPlaybook(input, gate)).resolves.toBe(true);

    expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM rag_operations_playbook").get()).toEqual({ count: 1 });
    expect(sqlite.db.prepare("SELECT id, title, embedding FROM rag_operations_playbook").get()).toEqual({
      id: "kb-new",
      title: "replacement",
      embedding: "[0.3,0.4]",
    });
  });

  it("同 ID 持久化仍依靠 upsert 更新内容且不改变 scenario", async () => {
    const { persistToPlaybook } = await loadGate("");
    useSqlite();
    sqlite.db.prepare(`INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, author, priority, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("kb-same", "old", "ops", "old content", '["old"]', "onzo", 1, "[0.1,0.2]");
    const input = makeInput({ id: "kb-same", title: "updated", scenario: "learning", content: "updated content" });
    const gate: GateResult = { action: "insert", reason: "test", embedding: [0.5, 0.6] };

    await expect(persistToPlaybook(input, gate)).resolves.toBe(true);

    const rows = sqlite.db.prepare("SELECT id, title, scenario, content FROM rag_operations_playbook").all();
    expect(rows).toEqual([{ id: "kb-same", title: "updated", scenario: "ops", content: "updated content" }]);
  });

  it("skip/reject 持久化仍直接返回 false", async () => {
    const { persistToPlaybook } = await loadGate("");
    const input = makeInput();

    await expect(persistToPlaybook(input, { action: "skip", reason: "dup" })).resolves.toBe(false);
    await expect(persistToPlaybook(input, { action: "reject", reason: "bad" })).resolves.toBe(false);
    expect(state.getDb).not.toHaveBeenCalled();
  });
});
