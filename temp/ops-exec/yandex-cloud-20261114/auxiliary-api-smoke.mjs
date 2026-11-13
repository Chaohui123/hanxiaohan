import express from "express";
import request from "supertest";
import { readFile, writeFile } from "node:fs/promises";
import { createYandexCloudRouter } from "../../../apps/api-services/dist/routes/yandex-cloud.route.js";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use("/api", createYandexCloudRouter());
const translateResponse = await request(app).post("/api/yandex-cloud/translate").send({ texts: ["冬季汽车水箱保温罩"], sourceLanguageCode: "zh" });
const sttResponse = await request(app).post("/api/yandex-cloud/stt").send({
  audioOggOpusBase64: (await readFile(new URL("./marina-stt-test.ogg", import.meta.url))).toString("base64"),
  confirmNoSensitiveData: true,
});
const ocrResponse = await request(app).post("/api/yandex-cloud/ocr").send({
  imageBase64: (await readFile(new URL("./ocr-test.png", import.meta.url))).toString("base64"),
  languages: ["zh", "en", "ru"],
  confirmNoSensitiveData: true,
});
const guardResponse = await request(app).post("/api/yandex-cloud/ocr").send({ imageBase64: "dGVzdA==" });
const result = {
  status: [translateResponse, sttResponse, ocrResponse].every(response => response.status === 200 && response.body.success && response.body.reviewRequired) && guardResponse.status === 400 ? "PASS" : "FAIL",
  translate: { httpStatus: translateResponse.status, body: translateResponse.body },
  stt: { httpStatus: sttResponse.status, body: sttResponse.body },
  ocr: { httpStatus: ocrResponse.status, body: ocrResponse.body },
  missingConfirmationGuard: { httpStatus: guardResponse.status, body: guardResponse.body },
};
await writeFile(new URL("./auxiliary-api-smoke-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, translate: result.translate, stt: result.stt, ocrStatus: result.ocr.httpStatus, ocrTextPreview: JSON.stringify(result.ocr.body.data).slice(0, 1000), guard: result.missingConfirmationGuard }, null, 2));
if (result.status !== "PASS") process.exit(1);
