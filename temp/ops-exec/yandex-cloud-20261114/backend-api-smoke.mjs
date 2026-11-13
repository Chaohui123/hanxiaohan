import express from "express";
import request from "supertest";
import { writeFile } from "node:fs/promises";
import { createYandexCloudRouter } from "../../../apps/api-services/dist/routes/yandex-cloud.route.js";

const app = express();
app.use(express.json());
app.use("/api", createYandexCloudRouter());
const response = await request(app)
  .post("/api/yandex-cloud/wordstat/top")
  .send({ phrase: "ремень вариатора снегоход", regions: [225], devices: "all", limit: 1 });
const result = {
  status: response.status === 200 && response.body.success && response.body.data ? "PASS" : "FAIL",
  httpStatus: response.status,
  route: "/api/yandex-cloud/wordstat/top",
  request: { phrase: "ремень вариатора снегоход", regions: [225], devices: "all", limit: 1 },
  response: response.body,
};
await writeFile(new URL("./backend-api-smoke-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASS") process.exit(1);
