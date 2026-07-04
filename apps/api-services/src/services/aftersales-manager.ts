// ============================================================
// Aftersales Manager — SQLite-persisted case management
// Templates remain in-memory (static config)
// ============================================================

import { getDb } from "../db/connection.js";

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
      await db.run("UPDATE aftersales_cases SET status=?, updated_at=datetime('now') WHERE id=?", [updates.status, id]);
    }
    if (updates.resolutionNote) {
      await db.run("UPDATE aftersales_cases SET resolution_note=?, updated_at=datetime('now') WHERE id=?", [updates.resolutionNote, id]);
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

  /** Get auto-reply templates (static, in-memory) */
  getTemplates(): AutoReplyTemplate[] { return templates; }
  getTemplateForReason(reason: RefundReason): AutoReplyTemplate | undefined { return templates.find(t => t.reason === reason); }
}
