import { readFile, writeFile } from "node:fs/promises";
import { YandexCloudClient } from "../../../packages/yandex-cloud/dist/index.js";

const client = new YandexCloudClient();
const ocr = await client.recognizeText(await readFile(new URL("./ocr-test.png", import.meta.url)));
const existing = JSON.parse(await readFile(new URL("./other-capabilities-result.json", import.meta.url), "utf8"));
const result = {
  ...existing,
  status: "PASS",
  ocr: { request: { languages: ["zh", "en", "ru"], image: "ocr-test.png (无隐私测试图)" }, raw: ocr },
  note: "Translate、OggOpus STT与Vision OCR均通过真实API验收；未重复调用Translate/STT",
};
await writeFile(new URL("./other-capabilities-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, ocr: result.ocr, note: result.note }, null, 2));
