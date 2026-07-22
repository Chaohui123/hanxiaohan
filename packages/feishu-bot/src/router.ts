/**
 * Inter-agent message forwarding helper.
 * Routes /promo commands to promo-agent via internal HTTP.
 */

import { logger } from "@onzo/logger";

export interface ForwardConfig {
  promoPort?: number;
  opsPort?: number;
}

const DEFAULT_PROMO_PORT = 9101;

/**
 * Forward a /promo command from ops-agent to promo-agent.
 * Returns true only when promo-agent actually accepted the message;
 * returns false on network/HTTP failure so the caller can surface an error
 * (previously failures were swallowed into a black hole).
 */
export async function forwardPromoCommand(
  text: string,
  ctx: { chatId: string; messageId: string; senderOpenId: string },
  config?: ForwardConfig,
): Promise<boolean> {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith("/promo") && !lower.startsWith("promo")) return false;

  // In Docker, "localhost" is the ops container itself — promo-agent must be
  // reached via the compose service name.
  const promoHost = process.env.PROMO_AGENT_HOST || "promo-agent";
  const promoPort = config?.promoPort || parseInt(process.env.PROMO_HEALTH_PORT || String(DEFAULT_PROMO_PORT), 10);

  try {
    const resp = await fetch(`http://${promoHost}:${promoPort}/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ctx),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, host: promoHost, port: promoPort }, "promo-agent /forward rejected");
      return false;
    }
    logger.info({ host: promoHost, port: promoPort, chatId: ctx.chatId }, "Command forwarded to promo-agent");
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message, host: promoHost, port: promoPort }, "promo-agent /forward unreachable");
    return false;
  }
}
