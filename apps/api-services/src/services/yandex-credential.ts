import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveYandexKeyFile } from "@onzo/yandex-cloud";

interface CredentialInput {
  service_account_id?: unknown;
  id?: unknown;
  private_key?: unknown;
  confirmProductionUpload?: unknown;
  [key: string]: unknown;
}

export async function saveYandexCredential(input: CredentialInput): Promise<{ configured: true; serviceAccountId: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Yandex credential JSON object is required");
  if (input.confirmProductionUpload !== true) throw new Error("confirmProductionUpload=true is required");
  const expectedId = process.env.YANDEX_CLOUD_SERVICE_ACCOUNT_ID || "ajenm8nu2hhln4p9op2c";
  if (input.service_account_id !== expectedId) throw new Error("service_account_id does not match the configured ONZO service account");
  if (typeof input.id !== "string" || !input.id.trim()) throw new Error("Yandex authorized key id is required");
  if (typeof input.private_key !== "string" || input.private_key.length < 1000 || input.private_key.length > 10_000 || !input.private_key.includes("-----BEGIN PRIVATE KEY-----") || !input.private_key.includes("-----END PRIVATE KEY-----")) {
    throw new Error("Yandex authorized key private_key is invalid");
  }
  const target = resolveYandexKeyFile();
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.service_account_key.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { configured: true, serviceAccountId: expectedId };
}
