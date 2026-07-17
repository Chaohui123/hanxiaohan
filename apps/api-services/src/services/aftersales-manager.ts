// ============================================================
// Aftersales Manager — SQLite-persisted case management
// Templates remain in-memory (static config)
// ============================================================

import { getDb } from "../db/connection.js";
import { EmbeddingClient } from "@onzo/embedding";
import { logger } from "@onzo/logger";

export type AftersalesType = "refund" | "return" | "exchange" | "complaint" | "question";
export type AftersalesStatus = "pending" | "processing" | "resolved" | "rejected";
export type RefundReason = "no_reason" | "quality_issue" | "wrong_item" | "damaged" | "late_delivery" | "change_mind" | "other";

export interface AftersalesCase {
  id: string; orderId: string; postingNumber: string;
  type: AftersalesType; status: AftersalesStatus; reason: RefundReason;
  description: string; buyerName: string; buyerMessage: string;
  createdAt: string; updatedAt: string;
  refundAmountRub?: number; resolutionNote?: string; attachments: string[];
}

export interface CaseSummary {
  totalCases: number; pendingCases: number; resolvedCases: number;
  rejectedCases: number; refundRate: number;
}

export interface AutoReplyTemplate { id: string; name: string; reason: RefundReason; subject: string; body: string; }

// Static reply templates (in-memory — rarely change)
const templates: AutoReplyTemplate[] = [
  { id: "1", name: "Quality Issue", reason: "quality_issue", subject: "Возврат по качеству", body: "Здравствуйте! Приносим извинения. Мы заменим товар или вернем деньги." },
  { id: "2", name: "Change of Mind", reason: "change_mind", subject: "Возврат", body: "Здравствуйте! Вы можете вернуть товар в течение 14 дней." },
  { id: "3", name: "Damaged", reason: "damaged", subject: "Поврежденный товар", body: "Здравствуйте! Отправьте фото повреждений, мы отправим замену." },
];

export class AftersalesManager {
  /** Create a new aftersales case (persisted to DB) */
  async createCase(params: Omit<AftersalesCase, "id" | "createdAt" | "updatedAt">): Promise<AftersalesCase | null> {
    const db = await getDb().catch(() => null);
    if (!db) return null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO aftersales_cases (id,order_id,posting_number,type,status,reason,description,buyer_name,buyer_message,refund_amount_rub,attachments_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, params.orderId, params.postingNumber, params.type, params.status, params.reason,
       params.description, params.buyerName, params.buyerMessage, params.refundAmountRub ?? null,
       JSON.stringify(params.attachments), now, now]
    );

    return { id, ...params, createdAt: now, updatedAt: now };
  }

  /** Get all cases, optionally filtered */
  async getCases(filter?: { status?: AftersalesStatus; type?: AftersalesType; limit?: number }): Promise<AftersalesCase[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    let sql = "SELECT * FROM aftersales_cases WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) { sql += " AND status=?"; params.push(filter.status); }
    if (filter?.type) { sql += " AND type=?"; params.push(filter.type); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filter?.limit ?? 50);

    const rows = await db.all(sql, params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string, orderId: r.order_id as string, postingNumber: r.posting_number as string,
      type: r.type as AftersalesType, status: r.status as AftersalesStatus,
      reason: (r.reason as RefundReason) || "other", description: (r.description as string) || "",
      buyerName: (r.buyer_name as string) || "", buyerMessage: (r.buyer_message as string) || "",
      refundAmountRub: r.refund_amount_rub as number | undefined,
      resolutionNote: r.resolution_note as string | undefined,
      attachments: JSON.parse((r.attachments_json as string) || "[]"),
      createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    }));
  }

  /** Update case status */
  async updateCase(id: string, updates: { status?: AftersalesStatus; resolutionNote?: string }): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;

    if (updates.status) {
      await db.run("UPDATE aftersales_cases SET status=?, updated_at=NOW() WHERE id=?", [updates.status, id]);
    }
    if (updates.resolutionNote) {
      await db.run("UPDATE aftersales_cases SET resolution_note=?, updated_at=NOW() WHERE id=?", [updates.resolutionNote, id]);
    }
  }

  /** Get case summary statistics */
  async getSummary(): Promise<CaseSummary> {
    const db = await getDb().catch(() => null);
    if (!db) return { totalCases: 0, pendingCases: 0, resolvedCases: 0, rejectedCases: 0, refundRate: 0 };

    const rows = await db.all(
      "SELECT status, COUNT(*) as cnt FROM aftersales_cases GROUP BY status"
    ) as Array<{ status: string; cnt: number }>;

    const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
    const total = rows.reduce((s, r) => s + r.cnt, 0);
    const refunds = map["refund"] || 0;
    return {
      totalCases: total, pendingCases: map["pending"] || 0,
      resolvedCases: map["resolved"] || 0, rejectedCases: map["rejected"] || 0,
      refundRate: total > 0 ? Math.round((refunds / total) * 100) / 100 : 0,
    };
  }

  /** Get single case by ID */
  async getCase(id: string): Promise<AftersalesCase | null> {
    const db = await getDb().catch(() => null);
    if (!db) return null;
    const rows = await db.all("SELECT * FROM aftersales_cases WHERE id = ? LIMIT 1", [id]) as AftersalesCase[];
    return rows[0] || null;
  }

  /** Alias for getSummary */
  async getCaseSummary(): Promise<CaseSummary> { return this.getSummary(); }

  /** Resolve a case */
  async resolveCase(id: string, note?: string): Promise<void> {
    await this.updateCase(id, { status: "resolved", resolutionNote: note });
  }

  /** Reject a case */
  async rejectCase(id: string, note?: string): Promise<void> {
    await this.updateCase(id, { status: "rejected", resolutionNote: note });
  }

  /** Get cases filtered by status */
  async getCasesByStatus(status: AftersalesStatus): Promise<AftersalesCase[]> {
    return this.getCases({ status });
  }

  /** Flag a case as potential bad review risk */
  async flagPotentialBadReview(id: string): Promise<void> {
    logger.warn({ caseId: id }, "Case flagged as potential bad review risk");
  }

  /** Add a new auto-reply template */
  async addAutoReplyTemplate(template: Omit<AutoReplyTemplate, "id">): Promise<AutoReplyTemplate> {
    const t: AutoReplyTemplate = { id: crypto.randomUUID(), ...template };
    templates.push(t);
    return t;
  }

  /** Get auto-reply templates (static, in-memory) */
  getTemplates(): AutoReplyTemplate[] { return templates; }
  getTemplateForReason(reason: RefundReason): AutoReplyTemplate | undefined { return templates.find((t) => t.reason === reason); }

  /** RAG-enhanced auto reply generation */
  async generateAutoReply(caseItem: AftersalesCase): Promise<{ reply: string; confidence: number; source: string }> {
    const db = await getDb().catch(() => null);
    if (!db) return { reply: "", confidence: 0, source: "none" };

    // 1. Build query text
    const queryText = `${caseItem.type} ${caseItem.reason} ${caseItem.buyerMessage}`;

    // 2. RAG vector search for similar scripts
    const embeddingClient = new EmbeddingClient();
    const queryVector = (await embeddingClient.embed(queryText)).vector;

    const similarScripts = await db.all(
      `SELECT id, category, scenario, content_ru, effectiveness_score, usage_count,
              1 - (embedding <=> $1::vector) AS similarity
       FROM rag_aftersales_scripts
       WHERE category = $2
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [`[${queryVector.join(",")}]`, caseItem.type],
    ) as Array<Record<string, unknown> & { similarity: number }>;

    if (similarScripts.length === 0) {
      const template = this.getTemplateForReason(caseItem.reason);
      return {
        reply: template?.body || "Здравствуйте! Мы рассмотрим ваше обращение в ближайшее время.",
        confidence: 0.3,
        source: "template_fallback",
      };
    }

    // 3. Select best script (weighted: similarity 60% + effectiveness 40%)
    const best = similarScripts.reduce((prev, curr) => {
      const prevScore = (prev.similarity || 0) * 0.6 + (Number(prev.effectiveness_score) || 0) * 0.4;
      const currScore = (curr.similarity || 0) * 0.6 + (Number(curr.effectiveness_score) || 0) * 0.4;
      return currScore > prevScore ? curr : prev;
    });

    const confidence = best.similarity || 0;

    // 4. High confidence: use directly
    if (confidence >= 0.85) {
      return { reply: String(best.content_ru), confidence, source: "rag_direct" };
    }

    // 5. Low confidence: use RAG results as context for DeepSeek
    const context = similarScripts.map((s) => s.content_ru).join("\n---\n");
    const deepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
    if (!deepseekApiKey) {
      return { reply: String(best.content_ru), confidence, source: "rag_fallback" };
    }

    try {
      const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekApiKey}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{
            role: "user",
            content: [
              "你是一个俄罗斯电商客服。根据以下历史话术参考，生成一段专业的俄语回复。",
              `买家问题: ${caseItem.buyerMessage}`,
              `问题类型: ${caseItem.type}`,
              `原因: ${caseItem.reason}`,
              `参考话术:\n${context}`,
              "要求: 1. 用俄语回复 2. 语气专业、礼貌 3. 针对买家具体问题 4. 不超过3句话",
            ].join("\n\n"),
          }],
          temperature: 0.3,
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        return { reply: String(best.content_ru), confidence, source: "rag_fallback" };
      }

      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const aiReply = data.choices?.[0]?.message?.content || String(best.content_ru);
      return { reply: aiReply, confidence: Math.min(confidence + 0.1, 1.0), source: "rag_ai_enhanced" };
    } catch {
      return { reply: String(best.content_ru), confidence, source: "rag_fallback" };
    }
  }
}
