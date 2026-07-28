#!/usr/bin/env node
// ============================================================
// ONZO Ozon 富内容 JSON 本地校验器 — validate a rich-content JSON file
// against the OFFICIAL Ozon schema BEFORE submitting to the Seller API
// (avoids the slow deep-validation rejection cycle).
//
// Usage:
//   node scripts/validate-rich-json.cjs <rich-content.json>
//
// Schema: assets/ozon-rich-schema.json (official, from cdn2.ozone.ru).
// Key hard requirements learned the hard way:
//   - top level: { content: [...], version: 0.3 }
//   - widgets carry widgetName (raShowcase/raTextBlock/raVideo/raTable/list)
//   - every img needs ALL of: src, srcMobile, width, height, widthMobile, heightMobile
// ============================================================

const fs = require("fs");

const file = process.argv[2];
if (!file) { console.error("用法: node scripts/validate-rich-json.cjs <rich-content.json>"); process.exit(1); }

const Ajv = require("../node_modules/.pnpm/ajv@7.2.4/node_modules/ajv").default;
const schema = JSON.parse(fs.readFileSync("assets/ozon-rich-schema.json", "utf8"));
const rich = JSON.parse(fs.readFileSync(file, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
// Validate against the V03 branch (current contract); V02 branch is legacy.
const validate = ajv.compile({ ...schema.anyOf[1], definitions: schema.definitions });
const ok = validate(rich);

if (ok) {
  console.log("✅ 通过官方 schema（V03）校验 — 可以提交 /v1/product/attributes/update");
} else {
  console.log(`❌ ${validate.errors.length} 处不符:`);
  validate.errors.slice(0, 20).forEach((e) => console.log(" -", e.instancePath || "/", e.message));
  process.exit(1);
}
