// Quick test: 1688 API — try multiple path formats
async function main() {
  const appKey = "1390512";
  const appSecret = "88CGgcf4v9m";
  const accessToken = "06a9b42a-4290-4c48-bcc7-a41986724016";
  const gateway = "https://gw.open.1688.com/openapi/";

  const { createHmac, randomUUID } = await import("node:crypto");

  async function call(apiPath: string, method = "GET", extraParams: Record<string,string> = {}) {
    const timestamp = String(Date.now());
    const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
    const params: Record<string,string> = {
      access_token: accessToken, app_key: appKey, timestamp,
      format: "json", v: "1.0", sign_method: "HMAC-SHA256", nonce,
      ...extraParams,
    };
    const sorted = Object.keys(params).sort();
    const queryStr = sorted.map(k => `${k}=${params[k]}`).join("");
    const signature = createHmac("sha256", appSecret).update(queryStr).digest("hex").toUpperCase();
    const qs = new URLSearchParams({...params, sign: signature}).toString();
    const url = `${gateway}${apiPath}/${appKey}?${qs}`;

    console.log(`\n--- ${method} ${apiPath} ---`);
    try {
      const resp = await fetch(url, {
        method,
        headers: method === "POST" ? {"Content-Type":"application/json"} : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      console.log(`  HTTP ${resp.status}`, JSON.stringify(data, null, 2).slice(0, 500));
      return data;
    } catch(e) {
      console.log("  Error:", (e as Error).message);
      return null;
    }
  }

  // Try multiple API path formats
  console.log("=== 探测 1688 可用 API 路径 ===");

  await call("param2/1/com.alibaba.trade/alibaba.trade.pay.protocol.get");
  await call("param2/1/com.alibaba.trade/alibaba.trade.create.order");
  await call("param2/1/com.alibaba.trade/alibaba.trade.get.order");
  await call("param2/2/com.alibaba.trade/alibaba.trade.get.order");
  await call("param2/1/com.alibaba.logistics/alibaba.logistics.trace.get");

  // Try member API to verify basic connectivity
  await call("param2/1/com.alibaba.member/alibaba.member.get");
  await call("param2/2/com.alibaba.member/alibaba.member.get");

  console.log("\n=== 探测完成 ===");
}
main().catch(e => { console.error(e.message); process.exit(1); });