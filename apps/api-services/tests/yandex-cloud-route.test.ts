import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createYandexCloudRouter } from "../src/routes/yandex-cloud.route.js";

function appWith(client: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createYandexCloudRouter(client as never));
  return app;
}

describe("Yandex Cloud routes", () => {
  it("exposes Wordstat top with the original operators and intent warning", async () => {
    const wordstatTop = vi.fn().mockResolvedValue({ totalCount: "12", results: [] });
    const response = await request(appWith({ wordstatTop }))
      .post("/api/yandex-cloud/wordstat/top")
      .send({ phrase: '"ремень вариатора"', regions: [225], limit: 100 });
    expect(response.status).toBe(200);
    expect(wordstatTop).toHaveBeenCalledWith({ phrase: '"ремень вариатора"', regions: [225], limit: 100 });
    expect(response.body.data.totalCount).toBe("12");
    expect(response.body.intentVerificationRequired).toBe(true);
    expect(response.body.request.phrase).toBe('"ремень вариатора"');
  });

  it("exposes dynamics, regions and web search through the shared client", async () => {
    const client = {
      wordstatDynamics: vi.fn().mockResolvedValue({ results: [] }),
      wordstatRegions: vi.fn().mockResolvedValue({ results: [] }),
      webSearch: vi.fn().mockResolvedValue({ rawXml: "<doc/>" }),
    };
    const app = appWith(client);
    await request(app).post("/api/yandex-cloud/wordstat/dynamics").send({ phrase: "ремень", period: "monthly", fromDate: "2026-01-01" }).expect(200);
    await request(app).post("/api/yandex-cloud/wordstat/regions").send({ phrase: "ремень", regionType: "cities" }).expect(200);
    const search = await request(app).post("/api/yandex-cloud/search").send({ query: "ремень вариатора купить", region: 225 }).expect(200);
    expect(search.body.data.rawXml).toBe("<doc/>");
    expect(client.wordstatDynamics).toHaveBeenCalledOnce();
    expect(client.wordstatRegions).toHaveBeenCalledOnce();
    expect(client.webSearch).toHaveBeenCalledOnce();
  });

  it("exposes Translate, STT and OCR with mandatory review semantics", async () => {
    const client = {
      translateToRussian: vi.fn().mockResolvedValue({ translations: [{ text: "Утеплитель радиатора" }] }),
      recognizeRussianOggOpus: vi.fn().mockResolvedValue({ result: "Проверка речи" }),
      recognizeText: vi.fn().mockResolvedValue({ results: [] }),
    };
    const app = appWith(client);
    const translated = await request(app).post("/api/yandex-cloud/translate").send({ texts: ["保温罩"], sourceLanguageCode: "zh" }).expect(200);
    expect(translated.body.reviewRequired).toBe(true);
    const audio = Buffer.from("ogg-audio").toString("base64");
    const stt = await request(app).post("/api/yandex-cloud/stt").send({ audioOggOpusBase64: audio, confirmNoSensitiveData: true }).expect(200);
    expect(stt.body.data.result).toBe("Проверка речи");
    const ocr = await request(app).post("/api/yandex-cloud/ocr").send({ imageBase64: Buffer.from("image").toString("base64"), confirmNoSensitiveData: true }).expect(200);
    expect(ocr.body.reviewRequired).toBe(true);
    expect(client.translateToRussian).toHaveBeenCalledWith(["保温罩"], "zh");
    expect(client.recognizeRussianOggOpus).toHaveBeenCalledOnce();
    expect(client.recognizeText).toHaveBeenCalledOnce();
  });

  it("rejects STT or OCR without explicit non-sensitive confirmation before upstream calls", async () => {
    const client = { recognizeRussianOggOpus: vi.fn(), recognizeText: vi.fn() };
    const app = appWith(client);
    await request(app).post("/api/yandex-cloud/stt").send({ audioOggOpusBase64: Buffer.from("audio").toString("base64") }).expect(400);
    await request(app).post("/api/yandex-cloud/ocr").send({ imageBase64: Buffer.from("image").toString("base64") }).expect(400);
    expect(client.recognizeRussianOggOpus).not.toHaveBeenCalled();
    expect(client.recognizeText).not.toHaveBeenCalled();
  });

  it("maps invalid input to 400 without claiming an upstream failure", async () => {
    const wordstatTop = vi.fn().mockRejectedValue(new Error("Wordstat limit must be an integer from 1 to 2000"));
    const response = await request(appWith({ wordstatTop })).post("/api/yandex-cloud/wordstat/top").send({ phrase: "test", limit: 2001 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_YANDEX_REQUEST");
  });
});
