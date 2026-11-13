import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveYandexCredential } from "../src/services/yandex-credential.js";
import { createYandexCloudRouter } from "../src/routes/yandex-cloud.route.js";

let directory: string;
let keyFile: string;
let previous: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "onzo-yandex-credential-"));
  keyFile = path.join(directory, "nested", "service_account_key.json");
  previous = process.env.YANDEX_CLOUD_SA_KEY_FILE;
  process.env.YANDEX_CLOUD_SA_KEY_FILE = keyFile;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.YANDEX_CLOUD_SA_KEY_FILE;
  else process.env.YANDEX_CLOUD_SA_KEY_FILE = previous;
  await rm(directory, { recursive: true, force: true });
});

function credential() {
  return {
    service_account_id: "ajenm8nu2hhln4p9op2c",
    id: "authorized-key-id",
    private_key: `-----BEGIN PRIVATE KEY-----\n${"x".repeat(1500)}\n-----END PRIVATE KEY-----`,
    confirmProductionUpload: true,
  };
}

describe("Yandex credential onboarding", () => {
  it("atomically writes the authorized key with restricted permissions", async () => {
    const result = await saveYandexCredential(credential());
    expect(result).toEqual({ configured: true, serviceAccountId: "ajenm8nu2hhln4p9op2c" });
    expect(JSON.parse(await readFile(keyFile, "utf8")).id).toBe("authorized-key-id");
    expect((await stat(keyFile)).isFile()).toBe(true);
  });

  it("rejects another service account before writing", async () => {
    await expect(saveYandexCredential({ ...credential(), service_account_id: "wrong-account" })).rejects.toThrow("does not match");
    await expect(stat(keyFile)).rejects.toThrow();
  });

  it("never returns private key material through the HTTP response", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createYandexCloudRouter({} as never));
    const response = await request(app).post("/api/yandex-cloud/credential").send(credential());
    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE KEY");
    expect(JSON.parse(await readFile(keyFile, "utf8")).service_account_id).toBe("ajenm8nu2hhln4p9op2c");
  });
});
