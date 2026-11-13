import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { YandexCloudClient } from "file:///app/packages/yandex-cloud/dist/index.js";

const client = new YandexCloudClient({ proxyUrl: process.env.YANDEX_CLOUD_PROXY_URL || undefined });
const phrase = "ремень вариатора снегоход";
const top = await client.wordstatTop({ phrase, regions: [225], devices: "all", limit: 1 });
const speech = await client.synthesizeRussian("Проверка русской речи. Этот товар поможет вам подготовиться к зимнему сезону.");
const audioPath = "/app/data/tmp-images/marina-production-smoke.wav";
await writeFile(audioPath, speech.audio);
const result = {
  status: "PASS",
  source: "ONZO production api-services with deployed Yandex credential",
  wordstat: { phrase, totalCount: top.totalCount, rows: top.results?.length || 0, first: top.results?.[0] || null },
  speechkit: { provider: "yandex", model: "speechkit-v3", voice: speech.voice, role: speech.role, chunks: speech.chunks, bytes: speech.audio.length, sha256: createHash("sha256").update(speech.audio).digest("hex"), audioPath },
  secretLogged: false,
  audioBase64Logged: false,
};
await writeFile("/app/data/backups/yandex-production-validation.json", JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result, null, 2));
