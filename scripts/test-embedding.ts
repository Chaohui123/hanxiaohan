// Test GLM vector embedding + semantic search on Ozon compliance knowledge
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const KEY = process.env.GLM_API_KEY || "";
const BASE = "https://open.bigmodel.cn/api/paas/v4";

interface EmbedResp { data: Array<{ embedding: number[] }>; error?: { message: string } }

async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "embedding-3", input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await resp.json()) as EmbedResp;
  if (data.error) throw new Error(data.error.message);
  return data.data.map((d) => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let d = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]; n1 += a[i] * a[i]; n2 += b[i] * b[i];
  }
  return d / (Math.sqrt(n1) * Math.sqrt(n2));
}

async function main() {
  console.log("=== GLM Embedding-3 向量检索测试 ===\n");

  // 1. Load knowledge items
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("./data/onzo.db");
  const items = db.prepare(
    "SELECT id,title,substr(content,1,400) as content FROM rag_operations_playbook ORDER BY priority DESC"
  ).all() as Array<{ id: string; title: string; content: string }>;
  console.log(`知识库条目: ${items.length}\n`);

  // 2. Embed all items
  console.log("向量化知识库...");
  const texts = items.map((i) => `${i.title}: ${i.content}`);
  const allEmbs = await embed(texts);
  console.log(`完成，维度: ${allEmbs[0].length}\n`);

  // 3. Test queries
  const queries = [
    "在Ozon卖电子产品需要什么认证",
    "禁售商品有哪些",
    "怎么做EAC认证",
    "儿童玩具的要求是什么",
    "违规会有什么处罚",
    "化妆品需要什么文件",
  ];

  for (const q of queries) {
    const [qEmb] = await embed([q]);
    const ranked = items
      .map((item, i) => ({ title: item.title, sim: cosine(qEmb, allEmbs[i]!) }))
      .sort((a, b) => b.sim - a.sim);

    console.log(`查询: "${q}"`);
    console.log(`  Top1: ${ranked[0]!.title} (${(ranked[0]!.sim * 100).toFixed(1)}%)`);
    console.log(`  Top2: ${ranked[1]!.title} (${(ranked[1]!.sim * 100).toFixed(1)}%)`);
    console.log(`  Top3: ${ranked[2]!.title} (${(ranked[2]!.sim * 100).toFixed(1)}%)`);
    console.log();
  }

  db.close();
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
