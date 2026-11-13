import { readFile } from "node:fs/promises";
import { YandexCloudClient } from "./client.js";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("Usage: node stt-cli.js <request.json>");
const request = JSON.parse(await readFile(requestPath, "utf8")) as { audio?: string; keyFile?: string };
if (!request.audio) throw new Error("STT request requires audio");
const client = new YandexCloudClient({ keyFile: request.keyFile });
const result = await client.recognizeRussianOggOpus(await readFile(request.audio));
process.stdout.write(JSON.stringify({ provider: "yandex", model: "speechkit-stt-v1", format: "oggopus", text: result.result }));
