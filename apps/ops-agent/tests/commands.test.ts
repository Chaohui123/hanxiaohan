import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/api-client.js", () => ({
  apiClient: {
    ready: vi.fn(),
    backup: vi.fn(),
    diagnose: vi.fn(),
    orders: vi.fn(),
    inventoryAlerts: vi.fn(),
    llmStats: vi.fn(),
    taskStats: vi.fn(),
    pipelineHealth: vi.fn(),
    syncOrders: vi.fn(),
    reconcile: vi.fn(),
  },
}));

vi.mock("../src/ai-diagnose.js", () => ({
  aiDiagnose: vi.fn(),
}));

vi.mock("@onzo/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiClient } from "../src/api-client.js";
import { registerCommands } from "../src/commands.js";
import type { FeishuBot, MsgContext } from "@onzo/feishu-bot";

function mockBot(): { bot: FeishuBot; msgs: { chatId: string; text: string }[]; cards: { chatId: string; title: string; action: string }[] } {
  const msgs: { chatId: string; text: string }[] = [];
  const cards: { chatId: string; title: string; action: string }[] = [];
  let msgHandler: ((ctx: MsgContext) => Promise<void>) | null = null;
  let cardHandler: ((action: { chatId: string; action: string }) => Promise<void>) | null = null;

  const bot = {
    sendMessage: vi.fn(async (chatId: string, text: string) => {
      msgs.push({ chatId, text });
    }),
    sendConfirmCard: vi.fn(async (chatId: string, title: string, _desc: string, action: string) => {
      cards.push({ chatId, title, action });
    }),
    onMessage: vi.fn((handler: (ctx: MsgContext) => Promise<void>) => {
      msgHandler = handler;
    }),
    onCardAction: vi.fn((handler: (action: { chatId: string; action: string }) => Promise<void>) => {
      cardHandler = handler;
    }),
    triggerMessage: async (ctx: MsgContext) => {
      if (msgHandler) await msgHandler(ctx);
    },
    triggerCard: async (action: { chatId: string; action: string }) => {
      if (cardHandler) await cardHandler(action);
    },
  };

  return { bot: bot as unknown as FeishuBot, msgs, cards };
}

const mockConfig = { apiBase: "http://test", apiKey: "key" };

describe("Commands", () => {
  let bot: ReturnType<typeof mockBot>["bot"] & { triggerMessage: (ctx: MsgContext) => Promise<void>; triggerCard: (a: { chatId: string; action: string }) => Promise<void> };
  let msgs: { chatId: string; text: string }[];
  let cards: { chatId: string; title: string; action: string }[];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = mockBot();
    bot = mock.bot as typeof bot;
    msgs = mock.msgs;
    cards = mock.cards;
  });

  it("help命令应返回帮助文本", async () => {
    registerCommands(bot as unknown as FeishuBot, mockConfig);
    await (bot as unknown as { triggerMessage: (ctx: MsgContext) => Promise<void> }).triggerMessage({ chatId: "c1", chatType: "group", messageId: "m1", text: "help", senderOpenId: "u1" });
    expect(msgs.some((m) => m.text.includes("status"))).toBe(true);
  });

  it("status命令应调用apiClient.ready", async () => {
    vi.mocked(apiClient.ready).mockResolvedValue({ status: "ok", checks: {}, uptime: 100 });
    registerCommands(bot as unknown as FeishuBot, mockConfig);
    await (bot as unknown as { triggerMessage: (ctx: MsgContext) => Promise<void> }).triggerMessage({ chatId: "c1", chatType: "group", messageId: "m1", text: "status", senderOpenId: "u1" });
    expect(apiClient.ready).toHaveBeenCalled();
  });

  it("backup命令应要求确认", async () => {
    registerCommands(bot as unknown as FeishuBot, mockConfig);
    await (bot as unknown as { triggerMessage: (ctx: MsgContext) => Promise<void> }).triggerMessage({ chatId: "c1", chatType: "group", messageId: "m1", text: "backup", senderOpenId: "u1" });
    expect(cards.some((c) => c.action === "backup")).toBe(true);
  });

  it("确认后应执行操作", async () => {
    vi.mocked(apiClient.backup).mockResolvedValue({ filename: "test.gz" });
    registerCommands(bot as unknown as FeishuBot, mockConfig);

    // First trigger backup command
    await (bot as unknown as { triggerMessage: (ctx: MsgContext) => Promise<void> }).triggerMessage({ chatId: "c1", chatType: "group", messageId: "m1", text: "backup", senderOpenId: "u1" });

    // Then confirm via card action
    await (bot as unknown as { triggerCard: (a: { chatId: string; action: string }) => Promise<void> }).triggerCard({ chatId: "c1", action: "backup" });

    // Check execution message
    expect(apiClient.backup).toHaveBeenCalled();
    expect(msgs.some((m) => m.text.includes("备份"))).toBe(true);
  });

  it("未知命令应返回帮助", async () => {
    registerCommands(bot as unknown as FeishuBot, mockConfig);
    await (bot as unknown as { triggerMessage: (ctx: MsgContext) => Promise<void> }).triggerMessage({ chatId: "c1", chatType: "group", messageId: "m1", text: "foobar123", senderOpenId: "u1" });
    expect(msgs.some((m) => m.text.includes("未知命令"))).toBe(true);
  });

  it("过期确认应提示", async () => {
    registerCommands(bot as unknown as FeishuBot, mockConfig);

    // Trigger card action without prior backup command
    await (bot as unknown as { triggerCard: (a: { chatId: string; action: string }) => Promise<void> }).triggerCard({ chatId: "c1", action: "backup" });

    expect(msgs.some((m) => m.text.includes("过期"))).toBe(true);
  });
});
