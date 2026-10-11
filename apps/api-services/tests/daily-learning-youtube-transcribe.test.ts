// daily-learning YouTube 转录接入测试（2026-10-11）：
// transcribeYouTubeWithWhisper（mock whisper 服务 fetch）+ processLearningItems enrich 钩子（content 拼接 + 上限跳过）
import { describe, it, expect, vi, afterEach } from "vitest";

// getDb mock：isAlreadyLearned fail-open 返回 false（不连真实 DB；PG 5s 超时+SQLite 落盘都太慢）
vi.mock("../src/db/connection.js", () => ({ getDb: async () => null }));

import {
  processLearningItems,
  transcribeYouTubeWithWhisper,
  YT_TRANSCRIBE_INTERVAL_MS,
} from "../src/jobs/daily-learning.js";

const makeItem = (url: string) => ({
  sourceId: url,
  source: "youtube" as const,
  title: "Тестовое видео",
  author: "канал",
  text: "rss описание",
  url,
  publishedAt: 1760000000,
});

const makeCtx = (distilled = 0) => ({
  seen: new Set<string>(),
  stats: { scanned: 0, learned: 0, newKeywords: 0, gated: 0, dup: 0, bySource: {} as Record<string, number> },
  learnedTitles: [] as string[],
  allKeywords: new Set<string>(),
  distilledPerSource: distilled ? { youtube: distilled } : ({} as Record<string, number>),
});

describe("transcribeYouTubeWithWhisper", () => {
  const oldFetch = global.fetch;
  afterEach(() => { global.fetch = oldFetch; });

  it("成功：POST videoUrl+language=ru 到 whisper /transcribe-youtube，text 截断 6000", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body || "{}") });
      return new Response(JSON.stringify({ text: "x".repeat(7000), source: "subtitle", duration: 61 }), { status: 200 });
    }) as typeof fetch;

    const text = await transcribeYouTubeWithWhisper(makeItem("https://www.youtube.com/watch?v=abc"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/transcribe-youtube");
    expect(calls[0].body).toEqual({ videoUrl: "https://www.youtube.com/watch?v=abc", language: "ru" });
    expect(text).toHaveLength(6000);
  });

  it("whisper 服务 502 → 返回空串（fail-open 回退标题/描述）", async () => {
    global.fetch = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    expect(await transcribeYouTubeWithWhisper(makeItem("https://youtu.be/x"))).toBe("");
  });

  it("whisper 服务连接失败（抛错）→ 返回空串不炸", async () => {
    global.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    expect(await transcribeYouTubeWithWhisper(makeItem("https://youtu.be/x"))).toBe("");
  });
});

describe("processLearningItems enrich 钩子（YouTube 转录接入）", () => {
  const oldFetch = global.fetch;
  afterEach(() => { global.fetch = oldFetch; });

  it("预算内：enrich 被调且转录文本替换 item.text（content 拼接基础）；间隔常量 ≥2s", async () => {
    // distillWithDeepSeek 若意外发起请求也 fail-open（无 DEEPSEEK_API_KEY 时本就直接返回 null）
    global.fetch = (async () => { throw new Error("should-not-fetch"); }) as typeof fetch;

    const item = makeItem("https://www.youtube.com/watch?v=enrich1");
    const ctx = makeCtx();
    const enriched: string[] = [];
    await processLearningItems([item], ctx, "[YT] ", async (it) => {
      enriched.push(it.url);
      it.text = "转录正文文本"; // 模拟 whisper 返回覆盖 RSS 描述
    });

    expect(enriched).toEqual([item.url]);
    expect(item.text).toBe("转录正文文本"); // content=标题+正文（distill 拼接标题，此处验证 text 被替换）
    expect(ctx.stats.scanned).toBe(1);
    expect(ctx.stats.bySource.youtube).toBe(1);
    expect(ctx.distilledPerSource.youtube).toBe(1); // 记了一次蒸馏消耗
    expect(YT_TRANSCRIBE_INTERVAL_MS).toBeGreaterThanOrEqual(2000); // 防风控间隔 ≥2s
  });

  it("达每源蒸馏上限：enrich 不触发（超限视频零转录消耗）", async () => {
    global.fetch = (async () => { throw new Error("should-not-fetch"); }) as typeof fetch;

    const ctx = makeCtx(5); // MAX_DISTILL_PER_SOURCE 默认 5，已达上限
    const enrich = vi.fn();
    await processLearningItems([makeItem("https://www.youtube.com/watch?v=over")], ctx, "[YT] ", enrich);

    expect(enrich).not.toHaveBeenCalled();
    expect(ctx.stats.scanned).toBe(0);
    expect(ctx.stats.bySource.youtube).toBeUndefined();
  });

  it("不传 enrich：行为与改造前一致（其他源零影响）", async () => {
    global.fetch = (async () => { throw new Error("should-not-fetch"); }) as typeof fetch;

    const item = makeItem("https://www.reddit.com/r/ecommerce/comments/x/");
    item.source = "reddit" as never;
    const ctx = makeCtx();
    await processLearningItems([item], ctx, "[Reddit] "); // 无第四参
    expect(ctx.stats.scanned).toBe(1); // 照常扫描计数
    expect(item.text).toBe("rss описание"); // text 不被触碰
  });
});
