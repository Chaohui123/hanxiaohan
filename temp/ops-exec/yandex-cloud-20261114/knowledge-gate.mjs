import fs from "node:fs";

const input = {
  id: "pb_yandex_cloud_ai_search_integration_20261114",
  title: "Yandex Cloud SpeechKit、Wordstat与AI能力接入（2026-11-14真实验收）",
  scenario: "ops",
  content: "来源：2026-11-14 Kimi主Agent在Yandex Cloud Console、Cloud Shell、真实Yandex API及ONZO本机代码的联合验收，综合证据temp/ops-exec/yandex-cloud-20261114/integration-result.json。account-dione-3300已Active/Paid并关联1个云，default文件夹b1g7kg5sf3nob759onuo与Cloud Shell可用。服务账号onzo-yandex-api仅TTS/STT/Translate/Vision/Search五项角色，无私有资源管理权限，密钥只在受控忽略路径，不打印或传模型。新增packages/yandex-cloud统一IAM PS256。俄语配音当前默认SpeechKit v3 marina+friendly、rate=+0%，make_vo_yandex逐句WAV与哈希验收，付费失败不自动重发、不静默换音色；真实样音22050Hz/mono/16-bit，Argon供应商隐藏盲评PASS 96分，OggOpus STT完整还原原句。Wordstat不再默认前台查询，统一scripts/yandex-wordstat.mjs与/api/yandex-cloud/wordstat/top|dynamics|regions、/api/yandex-cloud/search；真实Top、月度、地区、网页XML与结构化结果均通过，保留操作符/地区/设备/时间窗，关联词不自动判需求，缺失月份不按0，月度fromDate月初/toDate月末，周/月仅+操作符。Translate可作俄语初稿但须Kimi术语终审；STT同步v1用OggOpus而非MP3；Vision OCR必须text_detection_config并检查业务内层error，语言标签可能误识别。Cloud Functions/Object Storage/Lockbox仅access PASS count=0，未创建或迁移，Ozon Seller原生查询仍不能由Yandex替代。全项目83文件804项、视频66项、build通过，Lint 0 errors/215既有warnings。未上传ONZO服务器秘密、未提交部署，不宣称生产上线；Ozon商品价格库存、Direct与PROMO_AUTO_DECISION=false未改。",
  tags: ["Yandex Cloud", "SpeechKit", "marina", "Wordstat", "Search API", "Translate", "STT", "Vision OCR", "俄语配音"],
  author: "onzo",
  priority: 4,
};
const { knowledgeGate, persistToPlaybook } = await import("file:///app/apps/api-services/dist/services/knowledge-gate.js");
const { getDb } = await import("file:///app/apps/api-services/dist/db/connection.js");
const db = await getDb();
const before = await db.all("SELECT * FROM rag_operations_playbook ORDER BY id");
const backup = "/app/data/backups/knowledge-before-yandex-cloud-ai-20261114.json";
if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(before, null, 2));
const gate = await knowledgeGate(input);
const persisted = gate.action === "insert" || gate.action === "replace" ? await persistToPlaybook(input, gate) : false;
const stored = (await db.all("SELECT id, title, scenario, content FROM rag_operations_playbook WHERE id = $1", [input.id]))[0];
const response = await fetch("http://localhost:3000/api/rag/playbook/search", {
  method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY || "" },
  body: JSON.stringify({ query: "Yandex SpeechKit marina Wordstat 配音 搜索 API", scenario: "ops", topK: 5 }),
});
const body = await response.json();
const result = { id: input.id, action: gate.action, reason: gate.reason, replaceId: gate.replaceId || null, persisted, exactReadback: stored?.content === input.content, beforeCount: before.length, recall: { httpStatus: response.status, hits: (body.results || []).map(item => ({ id: item.id, scenario: item.scenario })) } };
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync("/app/data/backups/knowledge-yandex-cloud-ai-result-20261114.json", JSON.stringify(result, null, 2));
process.exit(persisted && stored?.content === input.content && response.ok && body.results?.[0]?.id === input.id ? 0 : 1);
