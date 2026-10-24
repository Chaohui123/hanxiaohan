import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: { message: { create: mocks.create } },
  })),
}));

vi.mock("@onzo/logger", () => ({
  logger: { error: mocks.error, info: vi.fn(), warn: vi.fn() },
}));

import { FeishuBot } from "../src/index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FeishuBot.sendMessage 发送结果契约", () => {
  it("SDK 发送成功返回 true", async () => {
    mocks.create.mockResolvedValue({ message_id: "message-id" });
    const bot = new FeishuBot({ appId: "app-id", appSecret: "app-secret" });

    await expect(bot.sendMessage("chat-id", "hello")).resolves.toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("SDK 发送失败被捕获并返回 false", async () => {
    mocks.create.mockRejectedValue(new Error("Feishu unavailable"));
    const bot = new FeishuBot({ appId: "app-id", appSecret: "app-secret" });

    await expect(bot.sendMessage("chat-id", "hello")).resolves.toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(
      { err: expect.any(Error), chatId: "chat-id" },
      "Feishu sendMessage failed",
    );
  });
});
