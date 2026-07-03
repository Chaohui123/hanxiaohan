import { describe, it, expect } from "vitest";
import { parseProductPage, type ExtractedPageData } from "../src/parser.js";
import type { ScrapedProduct } from "@onzo/shared-types";

function makePageData(overrides?: Partial<ExtractedPageData>): ExtractedPageData {
  return {
    title: "测试商品 - 阿里巴巴",
    html: "<html>...</html>",
    url: "https://detail.1688.com/offer/test.html",
    ogTitle: "测试商品 批发",
    ogDescription: "高品质测试商品，厂家直销",
    ogImage: "https://img.alicdn.com/test.jpg",
    ldJson: null,
    initialState: {
      sku: {
        skuPriceRange: { lowestPrice: "12.50", highestPrice: "25.00" },
        skuImageList: [
          { url: "//img.alicdn.com/imgextra/1.jpg" },
          { url: "//img.alicdn.com/imgextra/2.jpg" },
          { url: "//img.alicdn.com/imgextra/3.jpg" },
        ],
        skuProps: [
          { prop: "颜色", value: "红色" },
          { prop: "尺码", value: "XL" },
        ],
        soldCount: "1500",
      },
      globalData: { categoryPath: ["家居", "日用品", "收纳"] },
    },
    images: [],
    metaKeywords: "家居,日用品,收纳,批发",
    ...overrides,
  };
}

describe("parseProductPage", () => {
  it("extracts title from og:title", () => {
    const p = parseProductPage(makePageData({ title: "" }), "https://detail.1688.com/offer/test.html");
    expect(p.title).toBe("测试商品 批发");
  });

  it("extracts price range from initialState", () => {
    const p = parseProductPage(makePageData(), "https://detail.1688.com/offer/test.html");
    expect(p.price.currentMin).toBe(12.5);
    expect(p.price.currentMax).toBe(25.0);
    expect(p.price.currency).toBe("CNY");
  });

  it("extracts spec images and converts protocol-relative URLs", () => {
    const p = parseProductPage(makePageData(), "https://detail.1688.com/offer/test.html");
    expect(p.specImages).toHaveLength(3);
    expect(p.specImages[0]).toMatch(/^https:/);
  });

  it("extracts specifications from skuProps", () => {
    const p = parseProductPage(makePageData(), "https://detail.1688.com/offer/test.html");
    expect(p.specifications).toHaveLength(2);
    expect(p.specifications[0].name).toBe("颜色");
    expect(p.specifications[0].value).toBe("红色");
  });

  it("extracts category path from initialState", () => {
    const p = parseProductPage(makePageData(), "https://detail.1688.com/offer/test.html");
    expect(p.categoryPath).toEqual(["家居", "日用品", "收纳"]);
  });

  it("extracts sales info", () => {
    const p = parseProductPage(makePageData(), "https://detail.1688.com/offer/test.html");
    expect(p.salesInfo?.totalSold).toBe(1500);
  });

  it("handles missing initialState gracefully", () => {
    const p = parseProductPage(makePageData({ initialState: null }), "https://detail.1688.com/offer/test.html");
    expect(p.price.currentMin).toBe(0);
    expect(p.specImages).toHaveLength(0);
    expect(p.specifications).toHaveLength(0);
  });

  it("falls back to metaKeywords for category", () => {
    const p = parseProductPage(
      makePageData({ initialState: null, metaKeywords: "服装,女装,连衣裙" }),
      "https://detail.1688.com/offer/test.html"
    );
    expect(p.categoryPath.length).toBeGreaterThan(0);
  });

  it("rejects icon/avatar images in fallback mode", () => {
    const p = parseProductPage(
      makePageData({
        initialState: null,
        images: ["https://img.example.com/icon.png", "https://img.example.com/product.jpg", "https://img.example.com/avatar.png"],
      }),
      "https://detail.1688.com/offer/test.html"
    );
    expect(p.specImages).toHaveLength(1);
  });
});
