import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "@onzo/logger";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId?: string;
  port?: number; // HTTP callback port, default 8181
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

  onMessage(handler: MsgHandler): void {
    this.msgHandler = handler;
  }

  onCardAction(handler: CardHandler): void {
    this.cardHandler = handler;
  }

  // ---- REST API methods (unchanged) ----

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
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
        title: { tag: "plain_text", content: title },
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
          content: JSON.stringify({ text }),
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
        header?: {
          event_type?: string;
          event_id?: string;
          app_id?: string;
        };
        event?: Record<string, unknown>;
        challenge?: string;
      };

      // URL verification challenge
      if (payload.header?.event_type === "url_verification") {
        const challenge = (payload.event as { challenge?: string })?.challenge ||
          payload.challenge ||
          "";
        res.writeHead(200, { "Content-Type": "application/json" });
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

    this.msgHandler?.(ctx);
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

    const ctx: CardActionCtx = {
      chatId,
      action: action.value.action,
      value: action.value as Record<string, unknown>,
    };

    this.cardHandler?.(ctx);
  }
}
