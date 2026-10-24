// Ozon Performance API client (ads) — token + campaign operations.
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
const CID = get("OZON_PERF_CLIENT_ID") || "98932307-1785397806000@advertising.performance.ozon.ru";
const secretFile = fs.existsSync("temp/.perf-secret") ? fs.readFileSync("temp/.perf-secret", "utf8").trim() : "";
const SECRET = get("OZON_PERF_CLIENT_SECRET") || secretFile;
if (!CID || !SECRET) throw new Error("Missing Ozon Performance credentials in environment or temp/.perf-secret");
const BASE = "https://api-performance.ozon.ru";

let _token = null, _exp = 0;
async function token() {
  if (_token && Date.now() < _exp) return _token;
  const r = await fetch(`${BASE}/api/client/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: SECRET, grant_type: "client_credentials" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("token failed: " + JSON.stringify(d).slice(0, 200));
  _token = d.access_token; _exp = Date.now() + 1500_000;
  return _token;
}

async function perf(path, body = null, method = body ? "POST" : "GET") {
  const t = await token();
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 20000) }; }
  return { status: r.status, data };
}

module.exports = { perf };
