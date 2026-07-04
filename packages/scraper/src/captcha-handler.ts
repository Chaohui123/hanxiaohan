// ============================================================
// Captcha Handler — detect + notify + cooldown for 1688 anti-bot
// ============================================================

export interface CaptchaEvent {
  timestamp: string;
  url: string;
  captchaType: "slider" | "click" | "text" | "unknown";
  pageTitle: string;
  proxyUsed: string;
}

export class CaptchaHandler {
  private isCoolingDown = false;
  private cooldownUntil = 0;
  private captchaCount = 0;
  private lastCaptchaTime = 0;
  private notifyFn: ((event: CaptchaEvent) => Promise<void>) | null = null;

  /** Set notification callback (e.g. notifier.notify). */
  onCaptcha(fn: (event: CaptchaEvent) => Promise<void>): void {
    this.notifyFn = fn;
  }

  /**
   * Check if the current page shows 1688 captcha/anti-bot challenge.
   * Called after page load.
   */
  async detect(page: { url: () => string; title: () => Promise<string>; content: () => Promise<string> }): Promise<CaptchaEvent | null> {
    try {
      const content = await page.content();
      const lower = content.toLowerCase();

      // 1688 captcha indicators
      const captchaPatterns = [
        { pattern: /nc_1_n1z|nocaptcha|_nc_|nc_login_code|baxia-dialog/i, type: "slider" as const },
        { pattern: /验证码|拖动滑块|请按住滑块|安全验证|点击完成验证/i, type: "slider" as const },
        { pattern: /请点击|点击图中|文字点选|请按顺序点击/i, type: "click" as const },
        { pattern: /输入验证码|请输入.*验证|captcha.*input/i, type: "text" as const },
      ];

      for (const { pattern, type } of captchaPatterns) {
        if (pattern.test(content)) {
          const url = page.url();
          const pageTitle = await page.title().catch(() => "unknown");

          const event: CaptchaEvent = {
            timestamp: new Date().toISOString(),
            url,
            captchaType: type,
            pageTitle,
            proxyUsed: process.env.SCRAPER_PROXY_LIST || "direct",
          };

          this.recordCaptcha();
          await this.notify(event);
          return event;
        }
      }
    } catch {
      // Content extraction failed — probably not captcha
    }
    return null;
  }

  /** Check if scraper is in cooldown (should pause scraping). */
  get paused(): boolean {
    if (!this.isCoolingDown) return false;
    if (Date.now() > this.cooldownUntil) {
      this.isCoolingDown = false;
      return false;
    }
    return true;
  }

  /** Get cooldown remaining seconds. */
  get cooldownRemaining(): number {
    if (!this.isCoolingDown) return 0;
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }

  /** Get captcha statistics for monitoring. */
  get metrics() {
    return {
      captchaCount: this.captchaCount,
      lastCaptchaTime: this.lastCaptchaTime ? new Date(this.lastCaptchaTime).toISOString() : null,
      isCoolingDown: this.isCoolingDown,
      cooldownRemaining: this.cooldownRemaining,
    };
  }

  /** Manual reset (for testing/admin). */
  reset(): void {
    this.isCoolingDown = false;
    this.cooldownUntil = 0;
  }

  // ---- Private ----

  private recordCaptcha(): void {
    this.captchaCount++;
    this.lastCaptchaTime = Date.now();

    // Escalating cooldown based on captcha frequency
    let cooldownMs = 5 * 60_000; // 5 min base

    if (this.captchaCount > 3 && this.captchaCount <= 5) {
      cooldownMs = 15 * 60_000; // 15 min
    } else if (this.captchaCount > 5) {
      cooldownMs = 60 * 60_000; // 1 hour
    }

    // If captchas are close together (< 2 min), escalate faster
    if (this.lastCaptchaTime - this.cooldownUntil < 2 * 60_000) {
      cooldownMs *= 2;
    }

    this.isCoolingDown = true;
    this.cooldownUntil = Date.now() + cooldownMs;

    console.warn(
      `[CaptchaHandler] Captcha #${this.captchaCount} detected! Cooldown: ${Math.round(cooldownMs / 60000)}min`
    );
  }

  private async notify(event: CaptchaEvent): Promise<void> {
    console.warn(`[CaptchaHandler] ${event.captchaType} captcha at ${event.url}`);

    if (this.notifyFn) {
      try {
        await this.notifyFn(event);
      } catch {
        // notification failure doesn't block
      }
    }
  }
}
