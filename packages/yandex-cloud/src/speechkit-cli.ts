import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { YandexCloudClient } from "./client.js";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("Usage: node speechkit-cli.js <request.json>");
const request = JSON.parse(await readFile(requestPath, "utf8")) as { text?: string; output?: string; keyFile?: string };
if (!request.text || !request.output) throw new Error("SpeechKit request requires text and output");
const output = path.resolve(request.output);
const client = new YandexCloudClient({ keyFile: request.keyFile });
const result = await client.synthesizeRussian(request.text);
await writeFile(output, result.audio, { flag: "wx" });
process.stdout.write(JSON.stringify({ provider: "yandex", model: "speechkit-v3", voice: result.voice, role: result.role, chunks: result.chunks, bytes: result.audio.length }));
