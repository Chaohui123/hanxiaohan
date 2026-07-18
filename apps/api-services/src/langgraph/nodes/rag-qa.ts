import { ProcurementState } from "../state.js";
// ============================================================
// Node 4: DeepSeek RAG Q&A — answer user questions about products/orders
// ============================================================

import type { RagResult } from "../state.js";
type StateType = typeof ProcurementState.State;
import { deepseekChatCompletion } from "../client/deepseek-client.js";
import { logger } from "@onzo/logger";

const SYSTEM_PROMPT = `You are an Ozon cross-border e-commerce assistant.
Answer questions about products, orders, pricing, and procurement.
Be concise. Use Chinese for responses.`;

export async function ragQaNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const query = state.ragQuery;
  if (!query) {
    return { ragResult: null, ragError: "" };
  }

  logger.info({ query: query.slice(0, 80) }, "LangGraph: RAG Q&A");

  try {
    // Build context from order data if available
    let context = "";
    if (state.ozonOrder) {
      context += `Order ${state.ozonOrder.postingNumber}: ${state.ozonOrder.products.length} products, ${state.ozonOrder.totalPriceRub} RUB\n`;
    }
    if (state.sourceMatches.length > 0) {
      context += `1688 sources: ${state.sourceMatches.map((m: { sku: number; purchasePriceCny: number }) => `SKU${m.sku} ¥${m.purchasePriceCny}`).join(", ")}\n`;
    }
    if (state.profit) {
      context += `Profit: ${state.profit.netProfitRub} RUB (${state.profit.marginPercent}%)\n`;
    }

    const userPrompt = context
      ? `Context:\n${context}\n\nQuestion: ${query}`
      : query;

    const resp = await deepseekChatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    const answer = resp.choices[0]?.message?.content || "";

    const result: RagResult = {
      query,
      answer,
      sources: context ? ["order_data", "sku_mapping"] : [],
      tokensUsed: resp.usage?.total_tokens || 0,
    };

    return { ragResult: result, ragError: "" };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg }, "LangGraph: RAG Q&A failed");
    return { ragError: msg, ragResult: null };
  }
}
