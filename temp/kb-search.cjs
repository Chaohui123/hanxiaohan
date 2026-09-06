// 知识库便捷检索（CLI/子代理开工前必用）：node temp/kb-search.cjs "查询词" [topK] [scenario]
// 走生产 API /api/rag/playbook/search（Kimi 向量检索 rag_operations_playbook）
if (process.platform === "win32" && process.stdout.isTTY) {
  try { require("child_process").execSync("chcp 65001 >nul"); } catch { /* best effort */ }
}
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const get = (k) => {
  const m = env.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const API_KEY = get("API_KEY") || get("X_API_KEY") || get("OZON_API_KEYS").split(",")[0];

const query = process.argv[2];
if (!query) {
  console.log('用法: node temp/kb-search.mjs "查询词" [topK=5] [scenario]');
  console.log('scenario 可选: learning/ops/sop/platform-rules/compliance/pricing/design/aftersales/competitor/market');
  process.exit(1);
}
const topK = parseInt(process.argv[3] || "5", 10);
const scenario = process.argv[4] || undefined;

(async () => {
  const resp = await fetch("https://huashangshangmao.top/api/rag/playbook/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ query, topK, scenario }),
  });
  if (!resp.ok) {
    console.error("HTTP", resp.status, (await resp.text()).slice(0, 200));
    process.exit(1);
  }
  const data = await resp.json();
  const results = data.results || [];
  if (results.length === 0) { console.log("（无召回）"); return; }
  for (const [i, r] of results.entries()) {
    console.log(`\n=== [${i + 1}] ${r.title} (scenario=${r.scenario}, score=${Number(r.score ?? r.similarity ?? 0).toFixed(3)})`);
    console.log(String(r.content || "").slice(0, 900));
  }
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
