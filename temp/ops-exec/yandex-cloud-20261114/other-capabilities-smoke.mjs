import { readFile, writeFile } from "node:fs/promises";
import { YandexCloudClient } from "../../../packages/yandex-cloud/dist/index.js";

const client = new YandexCloudClient();
const sourceText = "冬季汽车水箱保温罩，四层加厚，通用尺寸 100×70 厘米";
const translate = await client.translateToRussian([sourceText]);
const stt = await client.recognizeRussianOggOpus(await readFile(new URL("./marina-stt-test.ogg", import.meta.url)));
const ocr = await client.recognizeText(await readFile(new URL("./ocr-test.png", import.meta.url)));
const result = {
  status: "PASS",
  translate: { request: { sourceLanguageCode: "zh", targetLanguageCode: "ru", texts: [sourceText] }, raw: translate },
  stt: { request: { lang: "ru-RU", format: "oggopus", source: "Marina friendly TTS sample" }, raw: stt },
  ocr: { request: { languages: ["zh", "en", "ru"], image: "ocr-test.png (无隐私测试图)" }, raw: ocr },
  businessCandidates: {
    translate: "俄语商品文案初稿与术语统一，Kimi终审后才能上线",
    stt: "配音内容回读、供应商语音与售后语音工单转写",
    visionOcr: "无隐私采购凭证、标签与参数图识别；敏感信息不得上传",
  },
  productionChanges: false,
};
await writeFile(new URL("./other-capabilities-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
