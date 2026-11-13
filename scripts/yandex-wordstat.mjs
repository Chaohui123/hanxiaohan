import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { YandexCloudClient } from "../packages/yandex-cloud/dist/index.js";

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error("每个选项都必须有值");
    result[key.slice(2)] = value;
  }
  return result;
}

const args = argsFrom(process.argv.slice(2));
if (!args.phrase) {
  console.error("用法: node scripts/yandex-wordstat.mjs --phrase <词或操作符> [--regions 225] [--devices all] [--limit 50] [--output file.json] [--period monthly --dynamics-from YYYY-MM-DD --to-date YYYY-MM-DD] [--regions-stats all|cities|regions] [--search-intent]");
  process.exit(2);
}
process.env.YANDEX_CLOUD_PROXY_URL ||= "http://127.0.0.1:10808";
const regions = String(args.regions || "225").split(",").map(value => value.trim()).filter(Boolean);
const devices = args.devices || "all";
const limit = args.limit === undefined ? 50 : Number(args.limit);
const client = new YandexCloudClient({ keyFile: args["key-file"] });
const data = {
  top: await client.wordstatTop({ phrase: args.phrase, regions, devices, limit }),
};
if (args["dynamics-from"]) {
  data.dynamics = await client.wordstatDynamics({
    phrase: args.phrase,
    period: args.period || "monthly",
    fromDate: args["dynamics-from"],
    toDate: args["to-date"],
    regions,
    devices,
  });
}
if (args["regions-stats"]) data.regions = await client.wordstatRegions({ phrase: args.phrase, regionType: args["regions-stats"], devices });
if (args["search-intent"] !== undefined) data.search = await client.webSearch({ query: args["search-intent"] || args.phrase, region: regions[0], results: 10 });
const output = path.resolve(args.output || path.join("temp", `wordstat-api-${Date.now()}.json`));
await mkdir(path.dirname(output), { recursive: true });
const result = {
  status: "PASS",
  collectedAt: new Date().toISOString(),
  source: "Yandex Cloud Search API v2",
  request: { ...args, regions, devices, limit },
  data,
  intentVerificationRequired: true,
  note: "原始搜索量不等于目标购买需求；search结果仍须Kimi核验购买意图，缺失值不按0处理",
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ status: result.status, output, totalCount: data.top.totalCount, topRows: data.top.results?.length || 0, hasDynamics: Boolean(data.dynamics), hasRegions: Boolean(data.regions), hasSearch: Boolean(data.search), intentVerificationRequired: true }, null, 2));
