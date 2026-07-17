// ============================================================
// Token Counter — estimate LLM token usage, truncate contexts
// Uses 1 token ≈ 4 chars (English) or 1 token ≈ 1.5 chars (CJK)
// ============================================================

/** Rough token count: ~1 token per 4 chars for English, ~1.5 for CJK */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0x3040 && code <= 0x30FF) || (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x0400 && code <= 0x04FF)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** Count tokens for an array of chat messages */
export function countMessageTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.role) + estimateTokens(m.content) + 4, 0); // +4 for message framing
}

/**
 * Truncate context to fit within maxTokens.
 * Keeps system prompt intact, truncates user/assistant messages from the top.
 */
export function truncateContext(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Array<{ role: string; content: string }> {
  const systemMsg = messages.find((m) => m.role === "system");
  const others = messages.filter((m) => m.role !== "system");

  let total = countMessageTokens(messages);
  if (total <= maxTokens) return messages;

  // Remove oldest non-system messages until under limit
  const result = systemMsg ? [systemMsg] : [];
  let currentTokens = systemMsg ? estimateTokens(systemMsg.content) + 4 : 0;

  // Take from the end (most recent messages are more relevant)
  for (let i = others.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(others[i].content) + 4;
    if (currentTokens + msgTokens > maxTokens) break;
    result.splice(systemMsg ? 1 : 0, 0, others[i]);
    currentTokens += msgTokens;
  }

  return result;
}