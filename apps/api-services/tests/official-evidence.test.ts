import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractEvidenceKeywords,
  extractGeminiModelIds,
  extractHttpUrls,
  htmlToText,
  MAX_OFFICIAL_RESPONSE_BYTES,
  MAX_TOTAL_EVIDENCE_CHARS,
  normalizeOfficialUrl,
  prepareOfficialEvidence,
  safeOfficialUrl,
  selectEvidenceExcerpts,
  type OfficialFetch,
  type OfficialFetchResponse,
} from "../src/services/official-evidence.js";

const undiciMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(),
}));

vi.mock("undici", () => ({
  fetch: undiciMocks.fetch,
  ProxyAgent: undiciMocks.ProxyAgent,
}));

function asOfficialResponse(response: Response): OfficialFetchResponse {
  return response as unknown as OfficialFetchResponse;
}

function htmlResponse(html: string, init: ResponseInit = {}): OfficialFetchResponse {
  return asOfficialResponse(new Response(html, {
    ...init,
    status: init.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers },
  }));
}

function textResponse(text: string, init: ResponseInit = {}): OfficialFetchResponse {
  return asOfficialResponse(new Response(text, {
    ...init,
    status: init.status ?? 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...init.headers },
  }));
}

function redirectResponse(location: string): OfficialFetchResponse {
  return asOfficialResponse(new Response(null, { status: 302, headers: { Location: location } }));
}

const validDocument = `
  <html><head><style>secret style</style><script>ignoreInstructions()</script></head>
  <body><h1>Gemini speech</h1><p>gemini-3.8-flash-tts supports speech_metadata.</p>
  <p>Sulafat supports Russian with 24kHz, 16-bit output. Promotional pricing is $0.0336 in 2026; 2027 pricing changes.</p></body></html>
`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("official evidence URL safety", () => {
  it("提取 URL 时清理末尾标点与多余右括号，保留平衡括号", () => {
    const urls = extractHttpUrls(
      "（https://ai.google.dev/gemini-api/docs/speech?hl=fr）。 " +
      "https://cloud.google.com/docs/foo(bar). https://support.google.com/docs/answer】",
    );

    expect(urls).toEqual([
      "https://ai.google.dev/gemini-api/docs/speech?hl=fr",
      "https://cloud.google.com/docs/foo(bar)",
      "https://support.google.com/docs/answer",
    ]);
  });

  it("强制 hl=en 且安全证据 URL 不带 query", () => {
    const normalized = normalizeOfficialUrl("https://ai.google.dev/gemini-api/docs/speech?hl=fr#price");
    const parsed = new URL(normalized);

    expect(parsed.searchParams.get("hl")).toBe("en");
    expect(parsed.search).toBe("?hl=en");
    expect(safeOfficialUrl(normalized)).toBe("https://ai.google.dev/gemini-api/docs/speech");
  });

  it.each([
    "http://ai.google.dev/docs/speech",
    "https://user@ai.google.dev/docs/speech",
    "https://ai.google.dev:444/docs/speech",
    "https://ai.google.dev.example.com/docs/speech",
    "https://ai.google.dev/gemini-api/docs/speech?key=do-not-echo",
    "https://ai.google.dev/gemini-api/docs/speech?access_token=do-not-echo",
    "https://ai.google.dev/gemini-api/docs/speech?accessToken=do-not-echo",
    "https://ai.google.dev/gemini-api/docs/speech?clientKey=do-not-echo",
    "https://ai.google.dev/gemini-api/docs/speech?authorization=do-not-echo",
    "https://ai.google.dev/gemini-api/docs/speech?view=full",
    "https://ai.google.dev/gemini-api/docs/speech?authuser=0",
    "https://ai.google.dev/gemini-api/docs/speech?q=reflected",
    "https://ai.google.dev/gemini-api/docs/speech?query=reflected",
  ])("拒绝不安全官方 URL：%s", (url) => {
    expect(() => normalizeOfficialUrl(url)).toThrow();
  });

  it("敏感参数错误不会回显 query 或参数值", async () => {
    const result = await prepareOfficialEvidence(
      "Gemini 官方说明",
      "来源：https://ai.google.dev/gemini-api/docs/speech?token=very-secret-value",
      { fetchImpl: vi.fn() },
    );

    expect(result.kind).toBe("reject");
    expect(JSON.stringify(result)).not.toContain("very-secret-value");
    expect(JSON.stringify(result)).not.toContain("token=");
  });

  it("规范化后的重复官方 URL 只抓取一次", async () => {
    const fetchImpl = vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(validDocument));
    const result = await prepareOfficialEvidence(
      "Google speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech?hl=fr；https://ai.google.dev/gemini-api/docs/speech?hl=en。",
      { fetchImpl },
    );

    expect(result.kind).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://ai.google.dev/gemini-api/docs/speech?hl=en");
  });

  it("超过 8 个唯一官方 URL 时要求拆分，不悄悄漏审", async () => {
    const fetchImpl = vi.fn<OfficialFetch>();
    const urls = Array.from({ length: 9 }, (_, index) => `https://ai.google.dev/gemini-api/docs/${index}`).join(" ");
    const result = await prepareOfficialEvidence("Google 官方资料", `来源：${urls}`, { fetchImpl });

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("拆分") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("声称 Gemini 官方却没有白名单官方 URL 时在送审前拒绝", async () => {
    const result = await prepareOfficialEvidence("Gemini 官方型号说明", "Gemini 官方声称 gemini-9.9-fake-tts 已发布。");

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("官方 URL") });
  });

  it("内部 Gemini 实证、否定语境与远处官方字样不会触发强制官方核验", async () => {
    const result = await prepareOfficialEvidence(
      "Gemini 内部实测",
      "来源：https://example.com/project-log。gemini-3.8-flash-tts 是本项目实测型号，并非官方承诺。\n另一独立主题：官方运营规则。",
    );

    expect(result).toEqual({ kind: "none" });
  });

  it("标题提供 Google 语境时，正文跨行官方文档声明仍拒绝非官方来源", async () => {
    const fetchImpl = vi.fn<OfficialFetch>();
    const result = await prepareOfficialEvidence(
      "Google",
      "来源：https://example.com/docs。\n官方文档已经确认这条具体规则，并给出明确的操作要求。",
      { fetchImpl },
    );

    expect(result.kind).toBe("reject");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "官方声明已经确认这条具体规则",
    "官方公告已经确认这条具体规则",
    "官方政策已经确认这条具体规则",
    "官方规则已经确认这条具体规则",
    "官方规则明确规定这条具体规则",
    "官方规则要求按这条具体规则执行",
    "官方规则中对免费额度的适用范围有明确规定",
    "官方规则对免费额度的适用范围有明确规定",
    "官方规则已写明免费额度的适用范围",
    "官方规则注明免费额度的适用范围",
    "官方规则载明免费额度的适用范围",
    "官方规则已明确免费额度的适用范围",
  ])("跨行来源性声明在抓取前拒绝：%s", async (statement) => {
    const fetchImpl = vi.fn<OfficialFetch>();
    const result = await prepareOfficialEvidence(
      "Google",
      `来源：https://example.com/docs。\n${statement}，并给出明确的操作要求。`,
      { fetchImpl },
    );

    expect(result.kind).toBe("reject");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "另一独立主题：官方规则。",
    "官方规则没有明确规定免费额度的适用范围。",
  ])("独立主题或否定官方规则没有肯定断言时不强制核验：%s", async (statement) => {
    const result = await prepareOfficialEvidence(
      "Google",
      `来源：https://example.com/docs。\n${statement}`,
    );

    expect(result).toEqual({ kind: "none" });
  });

  it.each([
    "https://ai.google.dev:bad/docs",
    "https://ai.google.dev./docs/speech",
    "https://ai.google.dev.evil.example/docs/speech",
  ])("疑似官方的畸形或仿冒地址 fail-closed：%s", async (url) => {
    const fetchImpl = vi.fn<OfficialFetch>();
    const result = await prepareOfficialEvidence("内部记录", `来源：${url}。这是一条足够长的技术记录。`, { fetchImpl });

    expect(result.kind).toBe("reject");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("support 搜索 query 反射不能伪造官方证据", async () => {
    const fetchImpl = vi.fn<OfficialFetch>();
    const result = await prepareOfficialEvidence(
      "Gemini",
      "来源：https://support.google.com/googleone/search?q=gemini-9.9-fake-tts%20supports%20speech_metadata%20and%2024kHz。",
      { fetchImpl },
    );

    expect(result.kind).toBe("reject");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://developers.google.com/SEARCH",
    "https://developers.google.com/%73earch",
    "https://developers.google.com/questions/123",
    "https://cloud.google.com/community%2Fthreads",
    "https://cloud.google.com/%2563ommunity%252Fthreads",
    "https://cloud.google.com/forum/discussion",
    "https://cloud.google.com/users/123",
    "https://support.google.com/googleone/search",
  ])("拒绝搜索、社区及编码变体路径：%s", (url) => {
    expect(() => normalizeOfficialUrl(url)).toThrow();
  });

  it("合法 support answer 帮助页可取证且只带强制 hl", async () => {
    const fetchImpl = vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(validDocument));
    const result = await prepareOfficialEvidence(
      "Gemini 官方帮助",
      "来源：https://support.google.com/googleone/answer/12345?hl=fr。gemini-3.8-flash-tts 支持 speech_metadata。",
      { fetchImpl },
    );

    expect(result.kind).toBe("ready");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://support.google.com/googleone/answer/12345?hl=en");
    if (result.kind === "ready") expect(result.sources[0].url).toBe("https://support.google.com/googleone/answer/12345");
  });

  it.each([
    "没有 Google 官方来源，这只是平台对比和日常运营学习记录。",
    "没有 Google 官方声明，这只是平台对比和日常运营学习记录。",
    "并未确认 Google 官方政策，这只是平台对比和日常运营学习记录。",
    "并未确认 Google 官方资料，这只是平台对比和日常运营学习记录。",
    "未能确认 Google 官方文档，这只是平台对比和日常运营学习记录。",
    "No Google official source; this is an ordinary operations note.",
    "Could not confirm Google official documentation; this is an ordinary operations note.",
  ])("Ozon 否定官方来源语境保持普通路径：%s", async (statement) => {
    const result = await prepareOfficialEvidence(
      "Ozon 日常学习",
      `来源：https://seller-edu.ozon.ru/example。${statement}`,
    );

    expect(result).toEqual({ kind: "none" });
  });
});

describe("official evidence fetching", () => {
  it("每跳使用 manual redirect 并强制英文，最终证据 URL 不含 query", async () => {
    const fetchImpl = vi.fn<OfficialFetch>()
      .mockResolvedValueOnce(redirectResponse("https://ai.google.dev/gemini-api/docs/speech?hl=fr"))
      .mockResolvedValueOnce(htmlResponse(validDocument));

    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/start?hl=fr。gemini-3.8-flash-tts 支持 24kHz。",
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://ai.google.dev/gemini-api/docs/start?hl=en");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://ai.google.dev/gemini-api/docs/speech?hl=en");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
    expect(fetchImpl.mock.calls[1][1].redirect).toBe("manual");
    expect(result).toMatchObject({ kind: "ready" });
    if (result.kind === "ready") {
      expect(result.sources[0].url).toBe("https://ai.google.dev/gemini-api/docs/speech");
      expect(result.sources[0].text).toContain("gemini-3.8-flash-tts");
    }
  });

  it("重定向出白名单时拒绝且不继续请求", async () => {
    const fetchImpl = vi.fn<OfficialFetch>()
      .mockResolvedValueOnce(redirectResponse("https://example.com/steal?token=hidden"));
    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/start。gemini-3.8-flash-tts 支持 24kHz。",
      { fetchImpl },
    );

    expect(result.kind).toBe("reject");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("token=hidden");
  });

  it("第 4 次重定向会被拒绝", async () => {
    const fetchImpl = vi.fn<OfficialFetch>();
    for (let index = 0; index < 4; index += 1) {
      fetchImpl.mockResolvedValueOnce(redirectResponse(`https://ai.google.dev/gemini-api/docs/${index + 1}`));
    }
    const result = await prepareOfficialEvidence("Google speech_metadata", "来源：https://ai.google.dev/gemini-api/docs/0", { fetchImpl });

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("超过 3 跳") });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "非 2xx", response: () => textResponse("server failure", { status: 503 }) },
    { name: "非文本 Content-Type", response: () => asOfficialResponse(new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } })) },
    { name: "空正文", response: () => textResponse("") },
    { name: "无有效文本", response: () => htmlResponse("<html><script>onlyScript()</script></html>") },
  ])("$name 均无法核验", async ({ response }) => {
    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(response()) },
    );

    expect(result.kind).toBe("reject");
  });

  it("请求超时返回 reject，不抛出正常门禁异常", async () => {
    const fetchImpl: OfficialFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("timed out", "TimeoutError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });

    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      { fetchImpl, timeoutMs: 5 },
    );

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("失败或超时") });
  });

  it("超过 1MiB 但未超过 2MiB 的真实类型页面可正常取证", async () => {
    const raw = `speech_metadata ${"a".repeat(1_200_000)}`;
    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(textResponse(raw)) },
    );

    expect(raw.length).toBeGreaterThan(1024 * 1024);
    expect(raw.length).toBeLessThanOrEqual(MAX_OFFICIAL_RESPONSE_BYTES);
    expect(result.kind).toBe("ready");
  });

  it("不信任 Content-Length，流式累计超过 2MiB 即拒绝并取消读取", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1_100_000).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = asOfficialResponse(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain", "Content-Length": "10" },
    }));
    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(response) },
    );

    expect(chunk.byteLength * 2).toBeGreaterThan(MAX_OFFICIAL_RESPONSE_BYTES);
    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("2MiB") });
    expect(cancelled).toBe(true);
  });

  it("代理仅接受 http/https/socks5，非法配置不会回退直连", async () => {
    vi.stubEnv("KNOWLEDGE_OFFICIAL_PROXY_URL", "ftp://127.0.0.1:10808");
    const result = await prepareOfficialEvidence("Gemini speech_metadata", "来源：https://ai.google.dev/gemini-api/docs/speech");

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("代理配置无效") });
    expect(undiciMocks.fetch).not.toHaveBeenCalled();
  });

  it("官方取证可单独使用 socks5 代理，不调用全局 fetch", async () => {
    vi.stubEnv("KNOWLEDGE_OFFICIAL_PROXY_URL", "socks5://127.0.0.1:10808");
    undiciMocks.fetch.mockResolvedValue(htmlResponse(validDocument));

    const result = await prepareOfficialEvidence(
      "Gemini speech_metadata",
      "来源：https://ai.google.dev/gemini-api/docs/speech。gemini-3.8-flash-tts 支持 24kHz。",
    );

    expect(undiciMocks.ProxyAgent).toHaveBeenCalledWith("socks5://127.0.0.1:10808");
    expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
    expect(undiciMocks.fetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(result.kind).toBe("ready");
  });
});

describe("official evidence text and excerpts", () => {
  it("无依赖清洗 HTML 并解码 named/numeric entities", () => {
    const text = htmlToText(`
      <!-- remove comment --><style>.bad{}</style><script>bad()</script>
      <noscript>no script</noscript><template>template</template><svg><text>svg</text></svg>
      <h1>Gemini &amp; speech</h1><p>24&#x20;kHz &#49;&#54;-bit &quot;Russian&quot; &nbsp; Sulafat</p>
    `);

    expect(text).toContain("Gemini & speech");
    expect(text).toContain("24 kHz 16-bit \"Russian\" Sulafat");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("remove comment");
    expect(text).not.toContain("template");
    expect(text).not.toContain("svg");
  });

  it("main/article 外导航不得污染 speech 与 Argon 主题证据", async () => {
    const nav = `<nav>${"NAV_MARKER Google Speech generation the and your 2026 ".repeat(120)}</nav>`;
    const speech = `${nav}<main><article class="devsite-article">
      <p>gemini-3.8-flash-tts supports speech_metadata.</p><p>${"lorem ".repeat(700)}</p>
      <p>Sulafat supports Russian with WAV PCM voice audio at 24 kHz, 24kHz, 16-bit and 16bit.</p>
    </article></main>`;
    const argon = `${nav}<main><article class="devsite-article">
      <h1>Gemini 4 Argon</h1><p>gemini-4-argon Inputs Text, Image, Video, Audio, PDF; Output Text.</p>
    </article></main>`;
    const fetchImpl = vi.fn<OfficialFetch>().mockImplementation(async (url) => (
      htmlResponse(url.includes("argon") ? argon : speech)
    ));
    const result = await prepareOfficialEvidence(
      "Google 官方多页资料",
      [
        "来源：https://ai.google.dev/gemini-api/docs/speech-generation 与 https://ai.google.dev/gemini-api/docs/models/gemini-4-argon。",
        "gemini-3.8-flash-tts 的 speech_metadata、Sulafat Russian；Gemini 4 Argon 内部评审使用 gemini-4-argon，Audio 输入与 Text 输出。",
      ].join("\n"),
      { fetchImpl },
    );

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      const speechText = result.sources[0].text;
      const argonText = result.sources[1].text;
      expect(speechText).toContain("speech_metadata");
      expect(speechText).toContain("Sulafat");
      expect(speechText).toContain("Russian");
      expect(speechText).not.toContain("NAV_MARKER");
      expect(speechText).not.toContain("2026");
      expect(argonText).toContain("gemini-4-argon");
      expect(argonText).toContain("Audio");
      expect(argonText).toContain("Output Text");
      expect(argonText).not.toContain("NAV_MARKER");
    }
  });

  it("定价长页保留目标模型后的完整 Input/Output 与促销上下文", async () => {
    const pricing = `<main><article class="devsite-article">
      <p>gemini-other-model</p><p>Input price $999</p><p>Output price $999</p>
      <p>${"filler ".repeat(1300)}</p>
      <h2>Gemini 3.8 Flash TTS</h2><p>gemini-3.8-flash-tts</p><p>${"detail ".repeat(100)}</p>
      <table><tr><td>Input price</td><td>Free of charge</td></tr>
      <tr><td>Output price</td><td>Free of charge through December 31, 2026. Equivalent to $0.00225 per 10s audio; 2027 pricing changes.</td></tr></table>
    </article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方定价",
      "来源：https://ai.google.dev/gemini-api/docs/pricing。gemini-3.8-flash-tts 的 Input price 与 Output price 为 Free of charge，促销价 $0.00225。",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      const text = result.sources[0].text;
      expect(text).toContain("gemini-3.8-flash-tts");
      expect(text).toContain("Input price");
      expect(text).toContain("Output price");
      expect(text).toContain("Free of charge");
      expect(text).toContain("$0.00225");
      expect(text).not.toContain("$999");
      expect(text.indexOf("gemini-3.8-flash-tts")).toBeLessThan(text.indexOf("Input price"));
      expect(text.indexOf("Input price")).toBeLessThan(text.indexOf("Output price"));
    }
  });

  it("合理多模型完整定价可通过", async () => {
    const models = ["gemini-test-model-a", "gemini-test-model-b", "gemini-test-model-c"];
    const pricing = `<main><article class="devsite-article">${models.map((model, index) => `
      <section><h2>${model}</h2><p>Input price $${index + 1}</p><p>Output price $${index + 2}</p>
      <p>${"detail ".repeat(500)}</p></section>
    `).join("")}</article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方多模型定价",
      `来源：https://ai.google.dev/gemini-api/docs/pricing。${models.join("、")} 的 Input price 与 Output price 均有官方记录。`,
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      for (const model of models) expect(result.sources[0].text).toContain(model);
    }
  });

  it.each([
    { name: "首项", missingIndex: 0 },
    { name: "中间项", missingIndex: 1 },
    { name: "末项", missingIndex: 2 },
  ])("换行联合价格声明在$name缺失时均拒绝", async ({ missingIndex }) => {
    const models = ["gemini-test-model-a", "gemini-test-model-b", "gemini-test-model-c"];
    const pricing = `<main><article class="devsite-article">${models.map((model, index) => `
      <section><h2>${model}</h2>
      ${index === missingIndex
        ? "<p>Migration notes only; no price table belongs to this section.</p>"
        : "<p>Input price $1</p><p>Output price $2</p>"}
      </section>
    `).join("")}</article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方多模型定价",
      `来源：https://ai.google.dev/gemini-api/docs/pricing。\n${models.join("、\n")} 的 Input price 与 Output price 均有官方记录。`,
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining(`型号 ${models[missingIndex]} 的 Input price/Output price`),
    });
  });

  it("分号另一侧的价格声明不会归给仅迁移说明的型号", async () => {
    const pricing = `<main><article class="devsite-article">
      <h2>gemini-test-model-a</h2><p>Migration notes only.</p>
      <h2>gemini-test-model-b</h2><p>Input price $1</p><p>Output price $2</p>
    </article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方定价",
      "来源：https://ai.google.dev/gemini-api/docs/pricing。gemini-test-model-a 仅有迁移说明；gemini-test-model-b 的 Input price 与 Output price 均有官方记录。",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result.kind).toBe("ready");
  });

  it("某一型号局部价格被预算截掉时，不能借用其他型号价格字段放行", async () => {
    const models = [
      "gemini-test-model-a",
      "gemini-test-model-b",
      "gemini-test-model-c",
      "gemini-test-model-d",
      "gemini-test-model-e",
      "gemini-test-model-f",
    ];
    const pricing = `<main><article class="devsite-article">${models.map((model, index) => `
      <section><h2>${model}</h2><p>${"detail ".repeat(index === 5 ? 220 : 10)}</p>
      <p>Input price $${index + 1}</p><p>Output price $${index + 2}</p>
      <p>${"filler ".repeat(500)}</p></section>
    `).join("")}</article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方多模型定价",
      `来源：https://ai.google.dev/gemini-api/docs/pricing。${models.join("、")} 的 Input price 与 Output price 均有官方记录。`,
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("型号 gemini-test-model-f 的 Input price/Output price"),
    });
  });

  it("pricing 主题中没有价格表的型号不要求凭空补证", async () => {
    const result = await prepareOfficialEvidence(
      "Google 官方定价",
      "来源：https://ai.google.dev/gemini-api/docs/pricing。gemini-no-price-model 仅有迁移说明。",
      {
        fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(
          "<main><article><p>gemini-no-price-model has migration notes but no price table in this local context.</p></article></main>",
        )),
      },
    );

    expect(result.kind).toBe("ready");
  });

  it("下一型号的价格表不能归给前面无价格表的型号", async () => {
    const pricing = `<main><article class="devsite-article">
      <p>gemini-test-model-a has no price table.</p>
      <p>gemini-test-model-b</p><p>Input price $1</p><p>Output price $2</p>
    </article></main>`;
    const result = await prepareOfficialEvidence(
      "Google 官方定价",
      "来源：https://ai.google.dev/gemini-api/docs/pricing。gemini-test-model-a 的 Input price 与 Output price 均有官方记录。",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(pricing)) },
    );

    expect(result).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("型号 gemini-test-model-a 的 Input price/Output price"),
    });
  });

  it("按不同关键词摘取后文上下文，而不是只取网页开头", () => {
    const keywords = ["gemini-3.8-flash-tts", "speech_metadata", "$0.0336", "24kHz", "Sulafat", "Russian"];
    const text = [
      "x".repeat(1000),
      "gemini-3.8-flash-tts model details",
      "y".repeat(500),
      "speech_metadata response field",
      "z".repeat(500),
      "price $0.0336 per unit",
      "a".repeat(500),
      "24kHz output",
      "b".repeat(500),
      "Sulafat voice",
      "c".repeat(500),
      "Russian language",
      "d".repeat(1000),
    ].join(" ");

    const selection = selectEvidenceExcerpts(text, keywords, 4000);

    expect(selection.text.length).toBeLessThanOrEqual(4000);
    expect(selection.text.length).toBeLessThan(text.length);
    for (const keyword of keywords) expect(selection.text.toLowerCase()).toContain(keyword.toLowerCase());
    expect(selection.coveredKeywords).toEqual(expect.arrayContaining(keywords));
  });

  it("截断有界且保留当前关键词", () => {
    const text = `${"a".repeat(1000)} speech_metadata ${"b".repeat(1000)}`;
    const selection = selectEvidenceExcerpts(text, ["speech_metadata"], 300);

    expect(selection.text.length).toBeLessThanOrEqual(300);
    expect(selection.text).toContain("speech_metadata");
  });

  it.each([
    { claimed: "$20", actual: "$20,000" },
    { claimed: "$0.10", actual: "$0.100" },
  ])("金额 $claimed 不能由 $actual 冒充覆盖", ({ claimed, actual }) => {
    const selection = selectEvidenceExcerpts(`Price ${actual}`, [claimed], 4000);

    expect(selection.text).toBe("");
    expect(selection.coveredKeywords).toEqual([]);
  });

  it("金额精确匹配允许正常句末标点", () => {
    const selection = selectEvidenceExcerpts("Price $20.", ["$20"], 4000);

    expect(selection.text).toBe("Price $20.");
    expect(selection.coveredKeywords).toEqual(["$20"]);
  });

  it.each([
    "gemini-3.8-flash-tts-preview",
    "gemini-3.8-flash-tts_preview",
  ])("官方型号只接受精确文本，不能用 %s 冒充基础型号", async (officialModel) => {
    const result = await prepareOfficialEvidence(
      "Gemini TTS",
      "来源：https://ai.google.dev/gemini-api/docs/speech。gemini-3.8-flash-tts 支持 speech_metadata。",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(`<p>${officialModel} supports speech_metadata and Russian voices.</p>`)) },
    );

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("未精确支撑") });
  });

  it("待审 _preview 型号不能被截成基础型号后放行", async () => {
    const result = await prepareOfficialEvidence(
      "Gemini TTS",
      "来源：https://ai.google.dev/gemini-api/docs/speech。gemini-3.8-flash-tts_preview 支持 speech_metadata。",
      {
        fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(htmlResponse(
          "<p>gemini-3.8-flash-tts supports speech_metadata and Russian voices.</p>",
        )),
      },
    );

    expect(result).toMatchObject({ kind: "reject", reason: expect.stringContaining("未精确支撑") });
  });

  it("旧型号在官方停用说明中有精确文本即可形成证据", async () => {
    const result = await prepareOfficialEvidence(
      "Gemini 停用说明",
      "来源：https://ai.google.dev/gemini-api/docs/deprecations。gemini-2.5-flash-image 已 discontinued。",
      { fetchImpl: vi.fn<OfficialFetch>().mockResolvedValue(textResponse("gemini-2.5-flash-image is discontinued and no fallback is available.")) },
    );

    expect(result.kind).toBe("ready");
  });

  it("多个来源的总摘录长度有界", async () => {
    const urls = Array.from({ length: 8 }, (_, index) => `https://ai.google.dev/gemini-api/docs/${index}`).join(" ");
    const fetchImpl = vi.fn<OfficialFetch>().mockImplementation(async (url) => {
      const index = new URL(url).pathname.split("/").pop();
      return textResponse(`speech_metadata ${index} ${"padding ".repeat(1500)}`);
    });
    const result = await prepareOfficialEvidence("Google speech_metadata", `来源：${urls}`, { fetchImpl });

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      const total = result.sources.reduce((sum, source) => sum + source.text.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_TOTAL_EVIDENCE_CHARS);
    }
  });

  it("模型、价格、语音参数和接口名都会成为检索关键词", () => {
    const keywords = extractEvidenceKeywords(
      "gemini-3.8-flash-tts，$0.0336，24kHz，16-bit，speech_metadata，Sulafat，Russian，2027",
    );

    expect(keywords).toEqual(expect.arrayContaining([
      "gemini-3.8-flash-tts",
      "$0.0336",
      "24kHz",
      "16-bit",
      "speech_metadata",
      "Sulafat",
      "Russian",
      "2027",
    ]));
    expect(extractGeminiModelIds("gemini-3.8-flash-tts。")).toEqual(["gemini-3.8-flash-tts"]);
    expect(extractGeminiModelIds("gemini-3.8-flash-tts_preview")).toEqual(["gemini-3.8-flash-tts_preview"]);
  });
});
