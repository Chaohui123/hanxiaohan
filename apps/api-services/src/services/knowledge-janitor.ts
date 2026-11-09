// ============================================================
// Knowledge Janitor — RAG 知识库定期维护（每周日 04:00）
//
// 维护动作（2026-09-05 用户要求：定期清理过期内容）：
//   1. 过期清理：按 scenario TTL（learning 180 天、market 90 天、ops 永久等）
//   2. 低质清理：无来源标注的短内容、明显占位/测试条目
//   3. 语义重复合并：相似度 >0.95 的条目对保留较优（长 + 新）一条
//   4. 明确取代关系清理（替代条目存在才删除）
//   5. 飞书维护报告
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent } from "./notification-events.js";
import { SCENARIO_TTL_DAYS } from "./knowledge-gate.js";
import { nowDb } from "../utils/time.js";

export interface JanitorReport {
  expired: number;
  lowQuality: number;
  duplicates: number;
  superseded: number;
  remaining: number;
}

export const PLAYBOOK_SUPERSESSIONS = [
  { id: "pb_opus_doc_consistency_followup_20261103", replacementId: "pb_followup_reliability_deployed_20261103" },
  { id: "pb_opus_expanded_routes_code_doc_audit_20261103", replacementId: "pb_followup_reliability_deployed_20261103" },
] as const;

export async function runKnowledgeJanitor(): Promise<JanitorReport> {
  const report: JanitorReport = { expired: 0, lowQuality: 0, duplicates: 0, superseded: 0, remaining: 0 };
  const db = await getDb().catch(() => null);
  if (!db) return report;

  for (const item of PLAYBOOK_SUPERSESSIONS) {
    const replacement = await db.all("SELECT id FROM rag_operations_playbook WHERE id = $1", [item.replacementId]);
    if (replacement.length === 0) {
      logger.error({ id: item.id, replacementId: item.replacementId }, "Janitor: supersession replacement missing; old entry retained");
      continue;
    }
    const result = await db.run("DELETE FROM rag_operations_playbook WHERE id = $1", [item.id]);
    report.superseded += result.changes;
  }

  // ---- 1. 过期清理（按 scenario TTL，参数化 cutoff 两侧兼容） ----
  for (const [scenario, ttlDays] of Object.entries(SCENARIO_TTL_DAYS)) {
    if (ttlDays <= 0) continue; // 永久保留
    const result = await db.run(
      "DELETE FROM rag_operations_playbook WHERE scenario = $1 AND created_at < $2",
      [scenario, nowDb(-ttlDays * 86400_000)],
    ).catch((err: Error) => {
      logger.warn({ scenario, err: err.message }, "Janitor: expire sweep failed");
      return { changes: 0 };
    });
    report.expired += result.changes;
  }

  // ---- 2. 低质清理 ----
  // 无来源标注且非官方作者的短内容；或明显的测试占位条目
  const lowQ = await db.run(
    `DELETE FROM rag_operations_playbook
     WHERE (length(content) < 50)
        OR (content NOT LIKE '%来源：%' AND content NOT LIKE '%来源:%'
            AND author NOT IN ('system', 'official', 'onzo', 'daily-learning', 'session-distill-2026-09')
            AND length(content) < 200)
        OR lower(title) LIKE '%test%' OR lower(title) LIKE '%测试%'`,
  ).catch((err: Error) => {
    logger.warn({ err: err.message }, "Janitor: low-quality sweep failed");
    return { changes: 0 };
  });
  report.lowQuality = lowQ.changes;

  // ---- 3. 语义重复合并（相似度 >0.95 保留较新较长的一条） ----
  try {
    const dupPairs = await db.all<{ keep_id: string; drop_id: string }>(
      `SELECT a.id AS keep_id, b.id AS drop_id
       FROM rag_operations_playbook a
       JOIN rag_operations_playbook b
         ON a.id < b.id
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) > 0.95
       ORDER BY (length(b.content) + length(a.content)) DESC
       LIMIT 20`,
    ).catch(() => [] as Array<{ keep_id: string; drop_id: string }>);

    const dropped = new Set<string>();
    for (const pair of dupPairs) {
      if (dropped.has(pair.keep_id) || dropped.has(pair.drop_id)) continue;
      // 保留内容更长的一条
      const [a] = await db.all<{ id: string; len: number }>("SELECT id, length(content) AS len FROM rag_operations_playbook WHERE id = $1", [pair.keep_id]);
      const [b] = await db.all<{ id: string; len: number }>("SELECT id, length(content) AS len FROM rag_operations_playbook WHERE id = $1", [pair.drop_id]);
      const dropId = (a?.len ?? 0) >= (b?.len ?? 0) ? pair.drop_id : pair.keep_id;
      await db.run("DELETE FROM rag_operations_playbook WHERE id = $1", [dropId]);
      dropped.add(dropId);
      report.duplicates++;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Janitor: dedup merge failed");
  }

  // ---- 4. 统计 + 飞书报告 ----
  const [countRow] = await db.all<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM rag_operations_playbook");
  report.remaining = Number(countRow?.cnt) || 0;

  if (report.expired > 0 || report.lowQuality > 0 || report.duplicates > 0 || report.superseded > 0) {
    await emitEvent("KNOWLEDGE_JANITOR", {
      expired: String(report.expired),
      lowQuality: String(report.lowQuality),
      duplicates: String(report.duplicates),
      superseded: String(report.superseded),
      remaining: String(report.remaining),
    }).catch(() => {});
  }

  logger.info(report, "KnowledgeJanitor: cycle complete");
  return report;
}
