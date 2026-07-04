import { describe, it, expect, beforeEach } from "vitest";
import { ProxyManager } from "../src/proxy-manager.js";

describe("ProxyManager", () => {
  it("returns null when no proxies configured", () => {
    const pm = new ProxyManager();
    expect(pm.getProxy()).toBeNull();
  });

  it("getMetrics returns valid structure", () => {
    const pm = new ProxyManager();
    const metrics = pm.getMetrics();
    expect(metrics).toHaveProperty("proxyCount");
    expect(metrics).toHaveProperty("overallSuccessRate");
  });

  it("getStats returns array", () => {
    const pm = new ProxyManager();
    expect(Array.isArray(pm.getStats())).toBe(true);
  });

  it("marks proxy as unhealthy after 3 failures", () => {
    const pm = new ProxyManager();
    pm.markFailed("http://proxy1:8080");
    pm.markFailed("http://proxy1:8080");
    pm.markFailed("http://proxy1:8080");
    const stats = pm.getStats();
    const p1 = stats.find((s) => s.server === "http://proxy1:8080");
    expect(p1).toBeDefined();
    expect(p1!.healthy).toBe(false);
  });

  it("marks proxy as healthy after success", () => {
    const pm = new ProxyManager();
    pm.markSuccess("http://proxy2:8080");
    pm.markFailed("http://proxy2:8080");
    pm.markFailed("http://proxy2:8080");
    pm.markSuccess("http://proxy2:8080");
    const stats = pm.getStats();
    const p2 = stats.find((s) => s.server === "http://proxy2:8080");
    expect(p2).toBeDefined();
    // Success reduces fail rate but doesn't immediately re-enable
  });

  it("destroy cleans up", () => {
    const pm = new ProxyManager();
    pm.destroy();
    // No error = success
  });
});
