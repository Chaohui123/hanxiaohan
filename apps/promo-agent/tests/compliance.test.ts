import { describe, it, expect } from "vitest";
import { auditText } from "../src/compliance/audit.js";

describe("auditText — 俄罗斯广告法", () => {
  it("包含最高级声明应标记为block", () => {
    const result = auditText("Это лучший товар в мире");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.violation.word === "лучший")).toBe(true);
  });

  it("包含第一声明应标记为block", () => {
    const result = auditText("номер один продукт");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.violation.word === "номер один")).toBe(true);
  });

  it("包含医疗声明应标记为block", () => {
    const result = auditText("Это лекарство лечит все болезни");
    expect(result.passed).toBe(false);
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);
  });

  it("含有可修复词的应自动替换", () => {
    const result = auditText("лучший товар");
    expect(result.autoFixed).not.toContain("лучший");
    expect(result.autoFixed).toContain("качественный");
  });
});

describe("auditText — Ozon平台规则", () => {
  it("包含仿品声明应标记为block", () => {
    const result = auditText("Это реплика известного бренда");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.violation.word === "реплика")).toBe(true);
  });

  it("包含强促性用语应标记为warn", () => {
    const result = auditText("купите сейчас по лучшей цене");
    const warnFindings = result.findings.filter((f) => f.violation.severity === "warn");
    expect(warnFindings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("auditText — 中国广告法", () => {
  it("包含最字级声明应标记为block", () => {
    const result = auditText("这是最好的产品");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.violation.word === "最")).toBe(true);
  });

  it("包含绝对化用语应标记为block", () => {
    const result = auditText("绝对有效100%有效");
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("auditText — 合规文案", () => {
  it("合规文案应通过审计", () => {
    const result = auditText("Качественный товар для дома и офиса");
    expect(result.passed).toBe(true);
    expect(result.blockedCount).toBe(0);
  });

  it("空文本应通过", () => {
    const result = auditText("");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it("纯数字文本应通过", () => {
    const result = auditText("12345");
    expect(result.passed).toBe(true);
  });
});

describe("auditText — 评分", () => {
  it("有block违规应扣分", () => {
    const result = auditText("лучший продукт номер один");
    expect(result.score).toBeLessThan(100);
  });

  it("仅有warn违规应通过但扣分", () => {
    const result = auditText("это супер товар");
    expect(result.passed).toBe(true); // warn doesn't block
    expect(result.score).toBeLessThan(100);
  });
});
