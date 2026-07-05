/**
 * Inter-agent message forwarding helper.
 * Routes /promo commands to promo-agent via internal HTTP.
 */

export interface ForwardConfig {
  promoPort?: number;
  opsPort?: number;
}

const DEFAULT_PROMO_PORT = 9101;

/**
 * Forward a /promo command from ops-agent to promo-agent.
 * Returns true if the message was forwarded.
 */
export async function forwardPromoCommand(
  text: string,
  ctx: { chatId: string; messageId: string; senderOpenId: string },
  config?: ForwardConfig,
): Promise<boolean> {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith("/promo") && !lower.startsWith("promo")) return false;

  const promoPort = config?.promoPort || parseInt(process.env.PROMO_HEALTH_PORT || String(DEFAULT_PROMO_PORT), 10);
  fetch(`http://localhost:${promoPort}/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ctx),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});

  return true;
}
