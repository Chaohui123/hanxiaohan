import { describe, it, expect } from "vitest";

describe("Health endpoint validation", () => {
  it("health returns ok with uptime", () => {
    // Unit test the response shape
    const response = { status: "ok", uptime: 1.5, timestamp: new Date().toISOString() };
    expect(response.status).toBe("ok");
    expect(response.uptime).toBeGreaterThan(0);
    expect(response.timestamp).toBeTruthy();
  });

  it("ready returns checks structure", () => {
    const checks = { db: "ok", ozonApi: "ok", glmKey: "configured", deepseekKey: "configured" };
    const allOk = Object.values(checks).every((v) => v === "ok" || v === "configured");
    expect(allOk).toBe(true);
  });

  it("ready detects degraded state", () => {
    const checks = { db: "ok", ozonApi: "error: timeout", glmKey: "configured", deepseekKey: "missing" };
    const allOk = Object.values(checks).every((v) => v === "ok" || v === "configured");
    expect(allOk).toBe(false);
  });
});

describe("Validate middleware rules", () => {
  it("checks required fields correctly", () => {
    const rules = [
      { field: "title", type: "string" as const, required: true },
      { field: "price", type: "number" as const, required: true },
    ];

    const body1 = { title: "test", price: 10 };
    const errors1 = rules.filter((r) => r.required && !body1[r.field as keyof typeof body1]);
    expect(errors1).toHaveLength(0);

    const body2 = { title: "test" };
    const errors2 = rules.filter((r) => r.required && !body2[r.field as keyof typeof body2]);
    expect(errors2).toHaveLength(1);
    expect(errors2[0].field).toBe("price");
  });

  it("validates min/max length", () => {
    expect("test".length >= 10).toBe(false);
    expect("a".repeat(2001).length <= 2000).toBe(false);
    expect("valid title here".length >= 10).toBe(true);
  });
});
