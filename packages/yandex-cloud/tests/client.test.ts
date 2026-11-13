import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearIamTokenCache, createServiceAccountJwt, YandexCloudClient } from "../src/index.js";

beforeEach(() => clearIamTokenCache());

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = {
  id: "key-id",
  service_account_id: "service-account-id",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function response(body: unknown, status = 200) {
  return { status, text: async () => typeof body === "string" ? body : JSON.stringify(body) } as never;
}

describe("Yandex Cloud client", () => {
  it("creates a PS256 JWT with the Yandex IAM audience and one-hour expiry", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    const token = createServiceAccountJwt(jwtKey, now);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ typ: "JWT", alg: "PS256", kid: "key-id" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: "service-account-id", aud: "https://iam.api.cloud.yandex.net/iam/v1/tokens",
      iat: now / 1000, exp: now / 1000 + 3600,
    });
    expect(signature.length).toBeGreaterThan(0);
  });

  it("uses SpeechKit v3 marina friendly without speed controls and decodes WAV chunks", async () => {
    const calls: Array<{ url: string; init: { body: string } }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: { body?: string }) => {
      const body = String(init?.body || "");
      calls.push({ url: String(url), init: { body } });
      if (String(url).includes("/iam/")) return response({ iamToken: "iam-token", expiresAt: "2026-11-14T12:00:00Z" });
      expect(JSON.parse(body)).toEqual({ text: "Проверка произношения", hints: [{ voice: "marina" }, { role: "friendly" }] });
      return response({ result: { audioChunk: { data: Buffer.from("RIFF-test-WAVE").toString("base64") } } });
    };
    const client = new YandexCloudClient({ fetchImpl: fetchImpl as never });
    const result = await client.synthesizeRussian("Проверка произношения");
    expect(result.audio.toString()).toBe("RIFF-test-WAVE");
    expect(result.voice).toBe("marina");
    expect(result.role).toBe("friendly");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://tts.api.cloud.yandex.net:443/tts/v3/utteranceSynthesis");
    expect(calls[1].init.body).not.toContain("speed");
  });

  it("maps Wordstat top requests to cloud types and preserves operators", async () => {
    const bodies: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: { body?: string }) => {
      const body = String(init?.body || "");
      bodies.push(body);
      if (bodies.length === 1) return response({ iamToken: "iam-token", expiresAt: "2026-11-14T12:00:00Z" });
      return response({ totalCount: "17", results: [{ phrase: "ремень вариатора", count: "12" }], associations: [] });
    };
    const client = new YandexCloudClient({ fetchImpl: fetchImpl as never });
    const result = await client.wordstatTop({ phrase: '"ремень вариатора"', limit: 100 });
    expect(JSON.parse(bodies[1])).toEqual({
      phrase: '"ремень вариатора"', numPhrases: "100", regions: ["225"], devices: ["DEVICE_ALL"], folderId: "b1g7kg5sf3nob759onuo",
    });
    expect(result.totalCount).toBe("17");
  });

  it("rejects unsupported weekly operators before calling the paid Wordstat API", async () => {
    let calls = 0;
    const client = new YandexCloudClient({ fetchImpl: (async () => { calls++; return response({}); }) as never });
    await expect(client.wordstatDynamics({ phrase: '"ремень вариатора"', period: "weekly", fromDate: "2026-10-01" })).rejects.toThrow("only the + operator");
    expect(calls).toBe(0);
  });

  it("validates Wordstat limits before any IAM or paid request", async () => {
    let calls = 0;
    const client = new YandexCloudClient({ fetchImpl: (async () => { calls++; return response({}); }) as never });
    await expect(client.wordstatTop({ phrase: "тест", limit: 2001 })).rejects.toThrow("1 to 2000");
    expect(calls).toBe(0);
  });

  it("accepts valid monthly boundaries after RFC3339 conversion", async () => {
    const bodies: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: { body?: string }) => {
      bodies.push(String(init?.body || ""));
      if (bodies.length === 1) return response({ iamToken: "iam-token", expiresAt: "2026-11-14T12:00:00Z" });
      return response({ results: [] });
    };
    const client = new YandexCloudClient({ fetchImpl: fetchImpl as never });
    await client.wordstatDynamics({ phrase: "ремень", period: "monthly", fromDate: "2026-01-01", toDate: "2026-10-31" });
    expect(JSON.parse(bodies[1])).toMatchObject({ fromDate: "2026-01-01T00:00:00Z", toDate: "2026-10-31T00:00:00Z", period: "PERIOD_MONTHLY" });
  });

  it("rejects non-month-end dynamics dates before any request", async () => {
    let calls = 0;
    const client = new YandexCloudClient({ fetchImpl: (async () => { calls++; return response({}); }) as never });
    await expect(client.wordstatDynamics({ phrase: "ремень", period: "monthly", fromDate: "2026-01-01", toDate: "2026-11-13" })).rejects.toThrow("last day of the month");
    expect(calls).toBe(0);
  });

  it("decodes Yandex search XML into reviewable result items", async () => {
    const rawXml = '<?xml version="1.0"?><yandexsearch><results><group><doc><url>https://www.ozon.ru/product/123</url><domain>www.ozon.ru</domain><title><hlword>Ремень</hlword> &amp; комплект</title><passages><passage>Купить &lt;online&gt;</passage></passages></doc></group></results>';
    const bodies: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: { body?: string }) => {
      bodies.push(String(init?.body || ""));
      if (bodies.length === 1) return response({ iamToken: "iam-token", expiresAt: "2026-11-14T12:00:00Z" });
      return response({ rawData: Buffer.from(rawXml).toString("base64") });
    };
    const client = new YandexCloudClient({ fetchImpl: fetchImpl as never });
    const result = await client.webSearch({ query: "ремень купить", results: 5 });
    expect(result.rawXml).toBe(rawXml);
    expect(result.results).toEqual([{ position: 1, title: "Ремень & комплект", url: "https://www.ozon.ru/product/123", domain: "www.ozon.ru", snippet: "Купить <online>" }]);
  });
});
