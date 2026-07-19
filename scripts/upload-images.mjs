// ============================================================
// Upload 1688 images to ONZO server
// Usage: node scripts/upload-images.mjs "D:/下载/商品文件夹名"
// Uploads all .jpg/.png from 主图/ and SKU图片/ sub-folders
// ============================================================

import { readdirSync, statSync, readFileSync } from "fs";
import { join, basename } from "path";
import { request } from "https";

const API_KEY = "9e5b520d53c815006d0a4cfaea6557f5aae1e54d4bde68a13d2a96eed913ca2b";
const API_HOST = "huashangshangmao.top";
const STORE_DIR = process.argv[2] || process.argv[1]?.replace(/scripts\/.*/, "");

if (!STORE_DIR) {
  console.log("Usage: node scripts/upload-images.mjs \"D:/下载/商品文件夹名\"");
  process.exit(1);
}

// Collect all images from 主图 + SKU图片 folders
const imageDirs = [join(STORE_DIR, "主图"), join(STORE_DIR, "SKU图片")];
const images = [];
for (const dir of imageDirs) {
  try {
    const files = readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f) && !f.includes("(1)"));
    for (const f of files) {
      images.push({ name: f, path: join(dir, f) });
    }
  } catch { /* folder may not exist */ }
}

if (images.length === 0) {
  console.log("No images found in", STORE_DIR);
  process.exit(1);
}

console.log(`Found ${images.length} images. Uploading...`);

// Upload in batches of 10
const BATCH = 10;
const results = [];

for (let i = 0; i < images.length; i += BATCH) {
  const batch = images.slice(i, i + BATCH);
  const boundary = "----ONZO" + Date.now();

  // Build multipart body
  const parts = [];
  for (const img of batch) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.name}"\r\nContent-Type: image/jpeg\r\n\r\n`));
    parts.push(readFileSync(img.path));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const resp = await new Promise((resolve, reject) => {
    const req = request({
      hostname: API_HOST, port: 443, path: "/api/image/upload", method: "POST",
      headers: {
        "X-API-Key": API_KEY,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  }) as { status: number; body: string };

  try {
    const json = JSON.parse(resp.body);
    if (json.success) {
      results.push(...json.data.urls);
      console.log(`  Batch ${i / BATCH + 1}: ${json.data.uploaded} uploaded`);
    } else {
      console.log(`  Batch ${i / BATCH + 1}: FAILED — ${json.error?.message}`);
    }
  } catch {
    console.log(`  Batch ${i / BATCH + 1}: HTTP ${resp.status}`);
  }
}

console.log(`\nDone! ${results.length} image URLs:`);
for (const url of results) {
  console.log("  " + url);
}
console.log("\nCopy the URLs above to use in the Ozon listing API.");
