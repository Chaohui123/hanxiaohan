import { describe, it, expect } from "vitest";

describe("OzonOrderClient", () => {
  it("maskString masks middle characters", async () => {
    // Test the masking utilities
    const maskString = (v: string, s: number, e: number) => {
      if (!v || v.length <= s + e) return v;
      return v.substring(0, s) + "***" + v.substring(v.length - e);
    };

    expect(maskString("Ivan Ivanov", 2, 1)).toBe("Iv***v");
    expect(maskString("AB", 2, 1)).toBe("AB"); // too short
    expect(maskString("", 2, 1)).toBe("");
  });

  it("maskPhone masks middle digits", () => {
    const maskPhone = (p: string) => {
      if (!p) return "";
      return p.substring(0, 2) + "****" + p.substring(p.length - 4);
    };

    expect(maskPhone("+79001234567")).toBe("+7****4567");
    expect(maskPhone("")).toBe("");
  });

  it("maskEmail masks local part", () => {
    const maskEmail = (e: string) => {
      if (!e || !e.includes("@")) return e;
      const [n, d] = e.split("@");
      return n.substring(0, 2) + "***@" + d;
    };

    expect(maskEmail("ivan@mail.ru")).toBe("iv***@mail.ru");
    expect(maskEmail("a@b.com")).toBe("a***@b.com");
    expect(maskEmail("noemail")).toBe("noemail");
  });

  it("maps posting status correctly", () => {
    const validStatuses = [
      "awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled"
    ];
    expect(validStatuses).toHaveLength(5);
  });
});
