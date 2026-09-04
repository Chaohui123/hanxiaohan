import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "@onzo/logger";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId?: string;
  port?: number; // HTTP callback port, default 8181
  /** Identity tag prepended to every outgoing message (e.g. "运维" / "推广")
   *  so users can tell agents apart when they share one bot identity. */
  tag?: string;
  /** 飞书事件订阅 Verification Token — 配置后所有回调强制校验，防止伪造事件（含伪造卡片"确认"） */
  verificationToken?: string;
}

export interface MsgContext {
  chatId: string;
  chatType: string;
  messageId: string;
  text: string;
  senderOpenId: string;
}

export interface CardActionCtx {
  chatId: string;
  action: string;
  value?: Record<string, unknown>;
}

type MsgHandler = (msg: MsgContext) => Promise<void>;
type CardHandler = (action: CardActionCtx) => Promise<void>;

export class FeishuBot {
  private client: Client;
  private config: FeishuConfig;
  private msgHandler: MsgHandler | null = null;
  private cardHandler: CardHandler | null = null;
  private server = createServer();

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  /** Prepend the identity tag (when configured) to outgoing text. */
  private withTag(text: string): string {
    return this.config.tag ? `[${this.config.tag}] ${text}` : text;
  }

  onMessage(handler: MsgHandler): void {
    this.msgHandler = handler;
  }

  onCardAction(handler: CardHandler): void {
    this.cardHandler = handler;
  }

  /** Trigger message handler externally (used for inter-agent forwarding) */
  async triggerMessage(ctx: MsgContext): Promise<void> {
    if (this.msgHandler) await this.msgHandler(ctx);
  }

  // ---- REST API methods (unchanged) ----

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: this.withTag(text) }),
        },
      });
    } catch (err) {
      logger.error({ err, chatId }, "Feishu sendMessage failed");
    }
  }

  async sendConfirmCard(
    chatId: string,
    title: string,
    description: string,
    action: string,
  ): Promise<void> {
    const card = {
      header: {
        title: { tag: "plain_text", content: this.withTag(title) },
        template: "warning" as const,
      },
      elements: [
        {
          tag: "div" as const,
          text: { tag: "lark_md" as const, content: description },
        },
        {
          tag: "action" as const,
          actions: [
            {
              tag: "button" as const,
              text: { tag: "plain_text" as const, content: "确认执行" },
              type: "danger" as const,
              value: { action },
            },
          ],
        },
      ],
    };

    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      logger.error({ err, chatId }, "Feishu sendConfirmCard failed");
    }
  }

  async sendPromoCard(chatId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      logger.error({ err, chatId }, "Feishu sendPromoCard failed");
    }
  }

  async replyMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: this.withTag(text) }),
        },
      });
    } catch (err) {
      logger.error({ err, messageId }, "Feishu replyMessage failed");
    }
  }

  // ---- HTTP callback server ----

  start(): Promise<void> {
    const port = this.config.port || 8181;

    this.server.on("request", (req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, () => {
        logger.info({ port }, "Feishu callback server listening");
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST to /feishu/events
    if (req.method !== "POST" || req.url !== "/feishu/events") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      this.processCallback(body, res);
    });
  }

  private processCallback(rawBody: string, res: ServerResponse): void {
    try {
      const payload = JSON.parse(rawBody) as {
        schema?: string;
        token?: string; // v1 verification token
        header?: {
          event_type?: string;
          event_id?: string;
          app_id?: string;
          token?: string; // v2 verification token
        };
        event?: Record<string, unknown>;
        challenge?: string;
      };

      // Verification token check (when configured) — 防伪造回调执行 pending 危险操作
      if (this.config.verificationToken) {
        const token = payload.header?.token || payload.token || "";
        // url_verification 握手也带 token，同样校验
        if (token !== this.config.verificationToken) {
          logger.warn({ eventType: payload.header?.event_type }, "Feishu callback rejected — bad verification token");
          res.writeHead(401).end();
          return;
        }
      }

      // URL verification challenge (v1: type=url_verification, v2: header.event_type=url_verification)
      if (
        payload.header?.event_type === "url_verification" ||
        (payload as Record<string, unknown>).type === "url_verification"
      ) {
        const challenge =
          (payload.event as { challenge?: string })?.challenge ||
          payload.challenge ||
          ((payload as Record<string, unknown>).challenge as string) ||
          "";
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ challenge }));
        logger.info("Feishu URL verification completed");
        return;
      }

      // Acknowledge immediately (Feishu requires <1s response)
      res.writeHead(200).end();

      // Process event asynchronously
      const eventType = payload.header?.event_type;
      const event = payload.event;

      if (!eventType || !event) return;

      if (eventType === "im.message.receive_v1") {
        this.handleMessageEvent(event);
      } else if (eventType === "card.action.trigger") {
        this.handleCardActionEvent(event);
      }
    } catch (err) {
      logger.error({ err }, "Feishu callback parse error");
      res.writeHead(400).end();
    }
  }

  private handleMessageEvent(event: Record<string, unknown>): void {
    const msg = event.message as
      | {
          chat_id?: string;
          chat_type?: string;
          message_id?: string;
          message_type?: string;
          content?: string;
        }
      | undefined;

    if (!msg?.chat_id) return;
    if (msg.message_type === "system") return;

    let text = "";
    try {
      const content = JSON.parse(msg.content || "{}") as { text?: string };
      text = content.text || "";
    } catch {
      text = msg.content || "";
    }

    if (!text.trim()) return;

    const chatId = msg.chat_id;

    // Chat ID authorization
    if (this.config.chatId && chatId !== this.config.chatId) {
      logger.warn({ chatId }, "Unauthorized chat access rejected");
      return;
    }

    const sender = event.sender as
      | { sender_id?: { open_id?: string } }
      | undefined;

    const ctx: MsgContext = {
      chatId,
      chatType: msg.chat_type || "p2p",
      messageId: msg.message_id || "",
      text: text.trim(),
      senderOpenId: sender?.sender_id?.open_id || "",
    };

    // handler 异常必须捕获 — 浮空 Promise 的 unhandledRejection 会打挂整个进程
    void Promise.resolve(this.msgHandler?.(ctx)).catch((err) =>
      logger.error({ err, chatId }, "Feishu message handler error")
    );
  }

  private handleCardActionEvent(event: Record<string, unknown>): void {
    const action = event.action as
      | { value?: { action?: string } }
      | undefined;

    const chatId =
      (event.open_chat_id as string) ||
      ((event.message as { chat_id?: string })?.chat_id) ||
      "";

    if (!action?.value?.action) return;

    // Chat ID authorization — 与消息路径一致；卡片按钮可触发 pending 危险操作，必须鉴权
    if (this.config.chatId && chatId !== this.config.chatId) {
      logger.warn({ chatId, action: action.value.action }, "Unauthorized card action rejected");
      return;
    }

    const ctx: CardActionCtx = {
      chatId,
      action: action.value.action,
      value: action.value as Record<string, unknown>,
    };

    void Promise.resolve(this.cardHandler?.(ctx)).catch((err) =>
      logger.error({ err, chatId }, "Feishu card handler error")
    );
  }
}
