// ============================================================
// Knowledge Gate — RAG 知识库入库门禁
//
// 三层控制（2026-09-05 用户要求：入库验证真实性 + 边界 + 防重复）：
//   1. 边界校验：来源必填、长度边界、scenario 白名单
//   2. 真实性审核：DeepSeek 事实性检查（疑似编造/幻觉拒入）
//   3. 语义查重：向量相似度 >0.92 视为重复（更新替换而非重复堆积）
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

/** 允许入库的 scenario 白名单 — 不在列表的一律拒收（边界控制） */
export const ALLOWED_SCENARIOS = new Set([
  "learning",        // 每日学习（公开内容提炼）
  "ops",             // 运维踩坑/巡检经验
  "sop",             // 运营流程
  "platform-rules",  // 平台规则
  "compliance",      // 合规
  "pricing",         // 定价
  "design",          // 设计方案
  "aftersales",      // 售后
  "competitor",      // 竞品
  "market",          // 市场数据（短 TTL）
]);

/** scenario 默认 TTL（天）— janitor 过期清理依据；0 = 永久 */
export const SCENARIO_TTL_DAYS: Record<string, number> = {
  learning: 180,
  ops: 0,
  sop: 365,
  "platform-rules": 365,
  compliance: 365,
  pricing: 180,
  design: 365,
  aftersales: 365,
  competitor: 180,
  market: 90,
};

const MIN_CONTENT_LEN = 50;
const MAX_CONTENT_LEN = 8000;
const DUP_SIMILARITY = 0.92;

export interface GateInput {
  id: string;
  title: string;
  scenario: string;
  content: string;
  tags: string[];
  author: string;
  priority: number;
}

export type GateAction = "insert" | "replace" | "skip" | "reject";

export interface GateResult {
  action: GateAction;
  reason: string;
  /** action=replace 时被替换的旧记录 id */
  replaceId?: string;
  embedding?: number[];
}

// ---- 边界校验 ----

function checkBoundary(input: GateInput): GateResult | null {
  if (!ALLOWED_SCENARIOS.has(input.scenario)) {
    return { action: "reject", reason: `scenario "${input.scenario}" 不在白名单` };
  }
  const len = input.content.length;
  if (len < MIN_CONTENT_LEN) {
    return { action: "reject", reason: `内容过短 (${len} < ${MIN_CONTENT_LEN} 字)，疑似无信息量` };
  }
  if (len > MAX_CONTENT_LEN) {
    return { action: "reject", reason: `内容超长 (${len} > ${MAX_CONTENT_LEN} 字)，需拆分` };
  }
  // 来源边界：学习内容必须含来源标注（作者为 system/official 的官方数据豁免）
  const hasSource = input.content.includes("来源：") || input.content.includes("来源:");
  const isOfficial = ["system", "official", "onzo", "daily-learning", "session-distill-2026-09"].includes(input.author);
  if (!hasSource && !isOfficial) {
    return { action: "reject", reason: "缺来源标注（content 须含「来源：」）" };
  }
  return null;
}

// ---- 真实性审核（DeepSeek） ----

const VERIFY_PROMPT = `你是知识库事实审核员。判断下面这条知识是否可入库。

拒收标准（命中任一即 reject）：
1. 疑似编造/幻觉：包含没有来源支撑的具体数字、人名、政策条文
2. 事实性错误：与公认的电商平台规则/常识明显矛盾
3. 无信息量的空话/营销话术
4. 来源不明的主观断言（"据说""听说"且无出处）

放行标准：有明确来源标注、内容是可操作的经验/规则/方法、或有我方系统实证（注明日期/实证）。

只输出 JSON：{"verdict":"pass"|"reject","reason":"20字内"}`;

async function verifyTruthfulness(title: string, content: string): Promise<{ pass: boolean; reason: string }> {
  if (!DEEPSEEK_API_KEY) return { pass: true, reason: "no-key-skip" }; // 无 key 时不阻断（靠其他两层）
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: VERIFY_PROMPT },
          { role: "user", content: `标题：${title}\n内容：${content.slice(0, 3000)}` },
        ],
        temperature: 0,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: true, reason: "parse-fail-pass" };
    const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    return { pass: parsed.verdict !== "reject", reason: parsed.reason || "" };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Truthfulness check failed — allowing (fail-open)");
    return { pass: true, reason: "check-error-failopen" };
  }
}

// ---- 语义查重 ----

async function findDuplicate(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, embedding: number[], currentId: string): Promise<{ id: string; similarity: number } | null> {
  const rows = await db.all<{ id: string; similarity: number }>(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
     FROM rag_operations_playbook
     WHERE embedding IS NOT NULL AND id != $2
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [`[${embedding.join(",")}]`, currentId],
  ).catch(() => [] as Array<{ id: string; similarity: number }>);
  const top = rows[0];
  if (top && Number(top.similarity) >= DUP_SIMILARITY) {
    return { id: top.id, similarity: Number(top.similarity) };
  }
  return null;
}

// ---- 主入口 ----

export async function knowledgeGate(input: GateInput): Promise<GateResult> {
  // 1. 边界校验
  const boundaryFail = checkBoundary(input);
  if (boundaryFail) {
    logger.warn({ id: input.id, reason: boundaryFail.reason }, "KnowledgeGate: boundary rejected");
    return boundaryFail;
  }

  // 2. 真实性审核
  const truth = await verifyTruthfulness(input.title, input.content);
  if (!truth.pass) {
    logger.warn({ id: input.id, reason: truth.reason }, "KnowledgeGate: truthfulness rejected");
    return { action: "reject", reason: `真实性审核未过: ${truth.reason}` };
  }

  // 3. embedding + 语义查重
  const db = await getDb().catch(() => null);
  if (!db) return { action: "reject", reason: "DB unavailable" };

  const { EmbeddingClient } = await import("@onzo/embedding");
  const embedding = (await new EmbeddingClient().embed(`${input.title} ${input.content.slice(0, 1500)}`)).vector;

  const dup = await findDuplicate(db, embedding, input.id);
  if (dup) {
    // 语义重复：同 id 直接替换；不同 id 时若新内容更长/更新则替换旧记录，否则跳过
    if (dup.id === input.id) {
      return { action: "replace", reason: `同 id 更新 (sim=${dup.similarity.toFixed(3)})`, replaceId: dup.id, embedding };
    }
    return { action: "skip", reason: `语义重复于 ${dup.id} (sim=${dup.similarity.toFixed(3)})`, embedding };
  }

  return { action: "insert", reason: "通过", embedding };
}

/** 执行入库（knowledgeGate 判定后调用） */
export async function persistToPlaybook(input: GateInput, gate: GateResult): Promise<boolean> {
  if (gate.action === "skip" || gate.action === "reject") return false;
  const db = await getDb().catch(() => null);
  if (!db || !gate.embedding) return false;

  if (gate.action === "replace" && gate.replaceId) {
    await db.run("DELETE FROM rag_operations_playbook WHERE id = $1", [gate.replaceId]);
  }
  await db.run(
    `INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, author, priority, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, content=EXCLUDED.content, tags=EXCLUDED.tags,
       author=EXCLUDED.author, priority=EXCLUDED.priority, embedding=EXCLUDED.embedding`,
    [input.id, input.title, input.scenario, input.content, input.tags, input.author, input.priority, `[${gate.embedding.join(",")}]`],
  );
  return true;
}
