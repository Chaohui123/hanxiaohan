import { writeFile } from "node:fs/promises";
import { YandexCloudClient } from "../../../packages/yandex-cloud/dist/index.js";

const client = new YandexCloudClient();
const dynamics = await client.wordstatDynamics({ phrase: "ремень вариатора снегоход", period: "monthly", fromDate: "2026-01-01", toDate: "2026-10-31", regions: [225], devices: "all" });
const regions = await client.wordstatRegions({ phrase: "ремень вариатора снегоход", regionType: "cities", devices: "all" });
const search = await client.webSearch({ query: "ремень вариатора на снегоход буран купить", region: 225, results: 5 });
const result = {
  status: "PASS",
  source: "Yandex Cloud Search API v2",
  dynamics: { request: { phrase: "ремень вариатора снегоход", period: "monthly", fromDate: "2026-01-01", toDate: "2026-10-31", regions: [225], devices: "all" }, raw: dynamics },
  regions: { request: { phrase: "ремень вариатора снегоход", regionType: "cities", devices: "all" }, raw: regions },
  search: { request: { query: "ремень вариатора на снегоход буран купить", region: 225, results: 5 }, raw: search },
  note: "真实API回执；搜索页原始XML保留供意图复核，不自动判为目标需求",
};
await writeFile(new URL("./search-dynamics-smoke-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, dynamics, regions, search }, null, 2));
