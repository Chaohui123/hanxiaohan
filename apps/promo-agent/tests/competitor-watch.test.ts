import { describe, it, expect, vi } from "vitest";
import { isScraperBlocked } from "../src/competitor-watch.js";

describe("competitor-watch — scraper state", () => {
  it("初始状态爬虫不应被封", () => {
    expect(isScraperBlocked()).toBe(false);
  });
});
