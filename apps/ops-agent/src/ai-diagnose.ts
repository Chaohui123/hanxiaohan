import type { ApiConfig } from "./api-client.js";
import { apiClient } from "./api-client.js";
import { logger } from "@onzo/logger";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

const SYSTEM_PROMPT = `你是 ONZO 跨境电商系统的运维专家。系统从 Ozon 平台同步订单，使用 AI（GLM/DeepSeek）进行商品上架和翻译，使用爬虫采集 1688 数据。

当收到系统状态数据时，请用中文输出：

根因分析：最可能的原因（1-2 句话）
影响范围：哪些业务受影响
建议操作：按优先级排列，标注是否可自动执行（如 /sync, /backup）
预计恢复：预计恢复时间

如果系统状态正常，简要确认即可，不需要冗长输出。`;

export async function aiDiagnose(config: ApiConfig, rawData: string): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    return "⚠️ 未配置 DEEPSEEK_API_KEY，无法生成 AI 诊断\n\n原始数据:\n\n" + rawData.slice(0, 3000) + "\n";
  }

  // RAG 知识库查询：历史诊断经验
  let ragContext = "";
  try {
    const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query: `诊断 ${rawData.slice(0, 100)}`, scenario: "diagnosis", topK: 5 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (ragResp.ok) {
      const ragData = await ragResp.json() as { results?: Array<{ content: string }> };
      if (ragData.results?.length) {
        ragContext = `以下是历史诊断经验参考：\n${ragData.results.map((r) => r.content).join("\n")}\n\n请结合以上经验进行诊断。`;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "RAG diagnosis query degraded, using pure AI diagnosis");
  }

  const systemPrompt = ragContext
    ? `${SYSTEM_PROMPT}\n\n${ragContext}`
    : SYSTEM_PROMPT;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `系统当前状态：\n${rawData.slice(0, 6000)}` },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`DeepSeek API ${resp.status}`);
    }

    const data = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content || "AI 诊断返回空内容";
    const tokens = data.usage?.total_tokens || 0;

    // RAG 写回：记录诊断结果
    fetch(`${config.apiBase}/api/rag/playbook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({
        title: `AI 诊断: ${rawData.slice(0, 50)}`,
        scenario: "diagnosis",
        content: `诊断结果:\n${content.slice(0, 500)}`,
        tags: ["诊断", "AI"],
        author: "ai-diagnose",
        priority: 1,
      }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});

    return `🤖 AI 诊断报告\n\n${content}\n\n---\nAI 诊断 | ${tokens} tokens`;
  } catch (err) {
    return `❌ AI 诊断失败: ${(err as Error).message}`;
  }
}
