import fs from "node:fs";

const input = {
  id: "pb_antigravity_region_us_recovery_20261114",
  title: "Antigravity Opus恢复与Hydrogen Pro切换（2026-11-14真实验收）",
  scenario: "ops",
  content: "来源：2026-11-14 用户确认Google账号关联美国生效后，Kimi主Agent使用Antigravity CLI 1.5.8真实stream-json、统一执行器和正式Windows周任务验收，综合证据temp/ops-exec/antigravity-region-us-20261114/routing-validation.json。Hydrogen High实际模型一致、request-review、SUCCESS，直接smoke为HYDROGEN_ANTIGRAVITY_OK、17246 tokens；scripts/gemini-hydrogen.py已改为Antigravity Pro，文本17213 tokens，视觉22084 tokens并实际read_file读取图片返回正确HYDROGEN/黄色圆/深蓝背景，实际HIGH元数据为空，不把文本推断冒充视觉。Opus High smoke为OPUS_ANTIGRAVITY_OK、17962 tokens，已恢复复杂代码审计、竞品证据、经营分析、分镜与经济复核。正式ONZO Weekly Review运行weekly-2026-11-13T19-44-55-598Z：model-route第二席恢复Opus/claude-opus-5-5-high，Astra/Opus/Argon/Kimi全部SUCCESS，Opus 89575 tokens、无工具调用，LastTaskResult=0，下一次仍11-16 14:41，报告SHA-256 921ccad0c2ffd697a95355f200bc6fa63e268c549b34de87884d4c734ecbb15a。报告为COMPLETED_WITH_DECLARED_GAPS，经营快照过期和竞品429继续标缺口，不写成当前健康证明。新周任务恢复Astra/Opus/Argon；历史Carbon文件按原模型恢复，未改名或删除，Carbon只作独立备选。执行器只允许Opus/Hydrogen High，拒绝其他模型/effort及跳过权限，正文与有效用量必须回读。系统代理ProxyEnable=0，无第三方反代和生产写入。全项目84文件809项、周复盘19项、配置5项及build通过，Lint 0 errors/215既有warnings。旧地区失败和Carbon接替只作历史，不作为当前状态；未提交/推送本任务变更，PROMO_AUTO_DECISION=false不变。",
  tags: ["Antigravity", "Opus", "Hydrogen", "模型路由", "周复盘", "地区资格", "视觉理解"],
  author: "onzo",
  priority: 4,
};
const { knowledgeGate, persistToPlaybook } = await import("file:///app/apps/api-services/dist/services/knowledge-gate.js");
const { getDb } = await import("file:///app/apps/api-services/dist/db/connection.js");
const db = await getDb();
const before = await db.all("SELECT * FROM rag_operations_playbook ORDER BY id");
const backup = "/app/data/backups/knowledge-before-antigravity-region-us-20261114.json";
if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(before, null, 2));
const gate = await knowledgeGate(input);
const persisted = gate.action === "insert" || gate.action === "replace" ? await persistToPlaybook(input, gate) : false;
const stored = (await db.all("SELECT id, title, scenario, content FROM rag_operations_playbook WHERE id = $1", [input.id]))[0];
const response = await fetch("http://localhost:3000/api/rag/playbook/search", {
  method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY || "" },
  body: JSON.stringify({ query: "Antigravity Opus Hydrogen 改区 恢复 周复盘", scenario: "ops", topK: 5 }),
});
const body = await response.json();
const result = { id: input.id, action: gate.action, reason: gate.reason, replaceId: gate.replaceId || null, persisted, exactReadback: stored?.content === input.content, beforeCount: before.length, recall: { httpStatus: response.status, hits: (body.results || []).map(item => ({ id: item.id, scenario: item.scenario })) } };
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync("/app/data/backups/knowledge-antigravity-region-us-result-20261114.json", JSON.stringify(result, null, 2));
process.exit(persisted && stored?.content === input.content && response.ok && body.results?.[0]?.id === input.id ? 0 : 1);
