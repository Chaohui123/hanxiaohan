// ============================================================
// RAG Playbook Seed — pre-populate core operations knowledge
// Usage: pnpm seed:rag
// ============================================================

import "dotenv/config";
import { getDb, getAdapterType } from "../apps/api-services/src/db/connection.js";
import { EmbeddingClient } from "../packages/embedding/src/embedding-client.js";
import { logger } from "../packages/logger/src/index.js";

const playbookEntries = [
  {
    title: "利润率低于10%的商品定价策略",
    scenario: "pricing",
    content: "当商品利润率低于10%时，不建议降价促销。应考虑：1) 优化采购成本 2) 提升文案转化率 3) 捆绑销售提升客单价。如果竞品价格明显低于我方，优先优化文案而非打价格战。",
    tags: ["定价", "低利润", "策略"],
    priority: 2,
  },
  {
    title: "库存大于100且销量下滑的处理方案",
    scenario: "inventory",
    content: "库存积压且销量下滑时：1) 检查是否被竞品抢占了搜索排名 2) 适度降价(不超过5%)刺激销量 3) 优化商品标题和主图 4) 考虑参加Ozon促销活动 5) 如果持续2周无改善，考虑清仓处理",
    tags: ["库存", "积压", "销量下滑"],
    priority: 2,
  },
  {
    title: "竞品突然大幅降价的应对策略",
    scenario: "pricing",
    content: "竞品降价超过15%时：1) 不要立即跟进降价 2) 分析竞品降价原因（清仓/促销/永久调价）3) 如果是清仓，维持原价等竞品卖完 4) 如果是永久调价，评估我方利润空间后决定是否跟进 5) 同时优化文案突出差异化优势",
    tags: ["竞品", "降价", "应对"],
    priority: 2,
  },
  {
    title: "新品上架推广节奏",
    scenario: "promotion",
    content: "新品上架后：第1-3天观察自然流量 → 第4-7天如果无订单，优化标题和主图 → 第8-14天如果仍无起色，适度降价3-5% → 第15-30天如果转化率低于1%，考虑更换类目或下架",
    tags: ["新品", "推广", "节奏"],
    priority: 1,
  },
  {
    title: "俄罗斯退货处理标准流程",
    scenario: "aftersales",
    content: "俄罗斯消费者退货：1) 14天无理由退货是法定权利 2) 收到退货请求后24小时内响应 3) 确认商品完好后3天内退款 4) 退款金额按实际支付金额，不含运费 5) 保留退货记录用于分析质量问题",
    tags: ["退货", "俄罗斯", "流程"],
    priority: 2,
  },
  {
    title: "Ozon商品标题优化要点",
    scenario: "promotion",
    content: "Ozon搜索权重：1) 标题前30个字符最重要 2) 核心关键词放最前面 3) 包含品牌+品类+特征词 4) 避免堆砌关键词 5) 俄语语法正确 6) 不要使用全大写 7) 长度建议60-120字符",
    tags: ["标题", "优化", "Ozon"],
    priority: 1,
  },
  {
    title: "差评预防与处理策略",
    scenario: "aftersales",
    content: "差评预防：1) 发货前检查商品质量 2) 包装要牢固防运输损坏 3) 附赠小礼品提升好感 4) 发货后主动发消息告知物流信息。差评处理：1) 24小时内回复 2) 诚恳道歉 3) 提供解决方案（退款/换货/补偿）4) 不要与买家争论",
    tags: ["差评", "预防", "处理"],
    priority: 2,
  },
  {
    title: "季节性商品定价策略",
    scenario: "pricing",
    content: "季节性商品：1) 旺季前2个月开始备货 2) 旺季价格可上浮10-20% 3) 旺季末期提前降价清仓 4) 淡季可考虑下架减少仓储费 5) 注意俄罗斯主要节日：新年(12-1月)、妇女节(3月)、胜利日(5月)",
    tags: ["季节", "定价", "俄罗斯节日"],
    priority: 1,
  },
];

async function main() {
  logger.info("Starting RAG playbook seed...");

  const db = await getDb().catch(() => null);
  if (!db) {
    logger.error("Database unavailable — cannot seed");
    process.exit(1);
  }

  const embeddingClient = new EmbeddingClient({ maxRetries: 2 });
  const texts = playbookEntries.map((e) => `${e.title}\n${e.content}`);
  let embeddings: { vector: number[] }[];

  try {
    embeddings = await embeddingClient.embedBatch(texts);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Embedding failed — check API keys. Try EMBEDDING_PROVIDER=local for offline mode.");
    process.exit(1);
  }

  const isPG = getAdapterType() === "pg";
  let seeded = 0;
  for (let i = 0; i < playbookEntries.length; i++) {
    const entry = playbookEntries[i];
    const id = `playbook_${i}`;
    const vector = embeddings[i].vector;
    const vecStr = `[${vector.join(",")}]`;
    const tagsStr = entry.tags.join(",");

    try {
      if (isPG) {
        await db.run(
          `INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, embedding, author, priority)
           VALUES ($1, $2, $3, $4, $5, $6::vector, 'system', $7)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
          [id, entry.title, entry.scenario, entry.content, tagsStr, vecStr, entry.priority],
        );
      } else {
        // SQLite: embedding stored as JSON text
        await db.run(
          `INSERT OR REPLACE INTO rag_operations_playbook (id, title, scenario, content, tags, embedding, author, priority, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'system', ?, datetime('now'))`,
          [id, entry.title, entry.scenario, entry.content, tagsStr, JSON.stringify(vector), entry.priority],
        );
      }
      seeded++;
      logger.info({ id, title: entry.title }, "Seeded");
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, "Failed to seed entry");
    }
  }

  logger.info({ seeded, total: playbookEntries.length }, "RAG playbook seed complete");
  process.exit(0);
}

main();
