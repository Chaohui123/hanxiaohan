// Quick E2E test — verify each component independently
import "dotenv/config";

async function testOzonApi() {
  const { OzonClient, AuthManager } = await import("../packages/ozon-api-wrapper/src/index.js");
  const client = new OzonClient({
    auth: new AuthManager({
      clients: [{
        clientId: process.env.OZON_CLIENT_IDS!,
        apiKey: process.env.OZON_API_KEYS!,
      }],
    }),
    baseUrl: process.env.OZON_API_BASE,
  });
  const ok = await client.ping();
  console.log("[Ozon API]", ok ? "OK" : "FAIL");
  return ok;
}

async function testGlmApi() {
  const { GlmClient } = await import("../packages/ai/src/index.js");
  const client = new GlmClient({
    apiKey: process.env.GLM_API_KEY!,
    baseUrl: `${process.env.GLM_BASE_URL}/chat/completions`,
  });
  const resp = await client.chatCompletion({
    model: process.env.GLM_VISION_MODEL!,
    messages: [{ role: "user", content: "Say 'ok'" }],
    maxTokens: 10,
  });
  console.log("[GLM API]", resp.content.includes("ok") ? "OK" : "FAIL", "—", resp.content.substring(0, 80));
  return resp;
}

async function testDeepSeekApi() {
  const { DeepSeekClient } = await import("../packages/ai/src/index.js");
  const client = new DeepSeekClient({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    baseUrl: process.env.DEEPSEEK_BASE_URL!,
    flashModel: process.env.DEEPSEEK_FLASH_MODEL!,
    proModel: process.env.DEEPSEEK_PRO_MODEL!,
  });
  const resp = await client.chatCompletion({
    model: "flash",
    messages: [{ role: "user", content: "Say 'hello' in Russian" }],
    maxTokens: 20,
  });
  console.log("[DeepSeek API]", "OK", "—", resp.content.substring(0, 80));
  return resp;
}

async function main() {
  console.log("=== Testing connectivity ===");
  try { await testOzonApi(); } catch (e: any) { console.log("[Ozon API] FAIL:", e.message); }
  try { await testGlmApi(); } catch (e: any) { console.log("[GLM API] FAIL:", e.message); }
  try { await testDeepSeekApi(); } catch (e: any) { console.log("[DeepSeek API] FAIL:", e.message); }
  console.log("=== Done ===");
}

main();
