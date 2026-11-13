import { existsSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { resolveYandexKeyFile, YandexCloudClient, YandexCloudError } from "@onzo/yandex-cloud";
import { saveYandexCredential } from "../services/yandex-credential.js";

type YandexClient = Pick<YandexCloudClient, "wordstatTop" | "wordstatDynamics" | "wordstatRegions" | "webSearch" | "translateToRussian" | "recognizeRussianOggOpus" | "recognizeText">;

function decodeBase64(value: unknown, field: string, maximumBytes: number): Buffer {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/=\r\n]+$/.test(value)) throw new Error(`${field} must be base64`);
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.length > maximumBytes) throw new Error(`${field} must contain 1-${maximumBytes} decoded bytes`);
  return buffer;
}

function requireNoSensitiveData(req: Request): void {
  if (req.body?.confirmNoSensitiveData !== true) throw new Error("confirmNoSensitiveData=true is required; do not upload personal, payment, buyer or credential data");
}

function metadata(req: Request): Record<string, unknown> {
  return {
    success: true,
    source: "Yandex Cloud Search API v2",
    request: req.body,
    intentVerificationRequired: true,
    note: "关键词热度不自动等于目标购买需求；必须核验购买意图，未知字段不按0处理",
  };
}

export function createYandexCloudRouter(client: YandexClient = new YandexCloudClient()): Router {
  const router = Router();

  router.get("/yandex-cloud/status", (_req, res) => {
    res.json({
      success: true,
      configured: existsSync(resolveYandexKeyFile()),
      folderId: process.env.YANDEX_CLOUD_FOLDER_ID || "b1g7kg5sf3nob759onuo",
      services: ["speechkit", "wordstat", "webSearch", "translate", "stt", "visionOcr"],
      note: "configured只表示密钥文件存在；各服务可用性以真实API回执为准",
    });
  });

  router.post("/yandex-cloud/credential", async (req, res) => {
    try {
      const result = await saveYandexCredential(req.body || {});
      res.json({ success: true, ...result, note: "密钥已原子写入并设为600；响应与日志不回显私钥" });
    } catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/wordstat/top", async (req, res) => {
    try { res.json({ ...metadata(req), data: await client.wordstatTop(req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/wordstat/dynamics", async (req, res) => {
    try { res.json({ ...metadata(req), data: await client.wordstatDynamics(req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/wordstat/regions", async (req, res) => {
    try { res.json({ ...metadata(req), data: await client.wordstatRegions(req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/search", async (req, res) => {
    try { res.json({ ...metadata(req), data: await client.webSearch(req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/translate", async (req, res) => {
    try {
      const data = await client.translateToRussian(req.body?.texts, req.body?.sourceLanguageCode);
      res.json({ success: true, source: "Yandex Translate v2", request: req.body, reviewRequired: true, note: "仅作文案草稿，术语、品牌禁词与商品参数须由Kimi终审", data });
    } catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/stt", async (req, res) => {
    try {
      requireNoSensitiveData(req);
      const audio = decodeBase64(req.body?.audioOggOpusBase64, "audioOggOpusBase64", 1_000_000);
      const data = await client.recognizeRussianOggOpus(audio);
      res.json({ success: true, source: "Yandex SpeechKit STT v1", format: "oggopus", reviewRequired: true, data });
    } catch (error) { sendError(res, error); }
  });

  router.post("/yandex-cloud/ocr", async (req, res) => {
    try {
      requireNoSensitiveData(req);
      const image = decodeBase64(req.body?.imageBase64, "imageBase64", 10_000_000);
      const data = await client.recognizeText(image, req.body?.languages);
      res.json({ success: true, source: "Yandex Vision OCR", reviewRequired: true, note: "语言标签与文字均需复核；不得上传敏感截图", data });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

function sendError(res: Response, error: unknown): void {
  const status = error instanceof YandexCloudError ? error.status : 400;
  res.status(status).json({
    success: false,
    error: {
      code: error instanceof YandexCloudError ? "YANDEX_API_ERROR" : "INVALID_YANDEX_REQUEST",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
