import { constants, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch, ProxyAgent, type RequestInit } from "undici";

const IAM_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export interface IamOptions {
  keyFile?: string;
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ServiceAccountKey {
  id: string;
  service_account_id: string;
  private_key: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function resolveYandexKeyFile(keyFile?: string): string {
  return path.resolve(keyFile || process.env.YANDEX_CLOUD_SA_KEY_FILE || "data/secrets/yandex-cloud/service_account_key.json");
}

async function readServiceAccountKey(keyFile: string): Promise<ServiceAccountKey> {
  const parsed = JSON.parse(await readFile(keyFile, "utf8")) as Partial<ServiceAccountKey>;
  if (!parsed.id || !parsed.service_account_id || !parsed.private_key) {
    throw new Error("Yandex service account key is missing id, service_account_id or private_key");
  }
  return parsed as ServiceAccountKey;
}

export function createServiceAccountJwt(key: ServiceAccountKey, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "PS256", kid: key.id }));
  const payload = base64url(JSON.stringify({
    iss: key.service_account_id,
    aud: IAM_URL,
    iat: seconds,
    exp: seconds + 3600,
  }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: key.private_key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function getIamToken(options: IamOptions = {}): Promise<string> {
  const keyFile = resolveYandexKeyFile(options.keyFile);
  const now = options.now || Date.now;
  const cached = tokenCache.get(keyFile);
  if (cached && cached.expiresAt > now() + 300_000) return cached.token;
  const key = await readServiceAccountKey(keyFile);
  const jwt = createServiceAccountJwt(key, now());
  const proxyUrl = options.proxyUrl ?? process.env.YANDEX_CLOUD_PROXY_URL;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const response = await (options.fetchImpl || fetch)(IAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
    signal: AbortSignal.timeout(20_000),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`Yandex IAM returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { iamToken?: string; expiresAt?: string };
  if (!parsed.iamToken) throw new Error("Yandex IAM response did not contain iamToken");
  const expiresAt = parsed.expiresAt ? Date.parse(parsed.expiresAt) : now() + 43_200_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("Yandex IAM returned an invalid expiry");
  tokenCache.set(keyFile, { token: parsed.iamToken, expiresAt });
  return parsed.iamToken;
}

export function clearIamTokenCache(): void {
  tokenCache.clear();
}
