import { writeFile } from "node:fs/promises";
import { YandexCloudClient } from "../../../packages/yandex-cloud/dist/index.js";

const client = new YandexCloudClient();
const raw = await client.wordstatTop({ phrase: "ремень вариатора снегоход", regions: [225], devices: "all", limit: 10 });
const result = {
  status: "PASS",
  source: "Yandex Cloud Search API v2 Wordstat topRequests",
  region: { id: 225, name: "Россия" },
  devices: "all",
  request: { phrase: "ремень вариатора снегоход", limit: 10 },
  raw,
  businessIntentVerified: false,
  note: "仅验证API连通与原始字段，不作为选品需求结论",
};
await writeFile(new URL("./wordstat-smoke-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
