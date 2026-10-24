const fs = require("fs");
const env = fs.readFileSync(".env", "utf8");
const get = (k) => { const m = env.match(new RegExp(`^${k}=(.+)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
const API_KEY = get("API_KEY") || get("X_API_KEY");
const entries = [
  {
    title: "真实单元经济与调价硬闸门（2026-10-24 全链路上线实证）",
    scenario: "pricing",
    content: `【公式】固定成本=采购+OGL+打包；变动费用=佣金+CPS+国际运输0.33%+退货5%+电子服务clamp(2%,15,200₽)。有效价=卖家价与促销价取低。OGL目标价跨档不能用完价档：XS≤1500₽且≤500g，Small 1500-7000₽且≤2000g，必须枚举目标档反解，ceil后仍达标。默认CPS 23%（后台全店实证），61N精选35%，支持offer override。
【硬闸门】汇率/订单/成本/库存/重量异常均阻断价格动作；降价和竞品优势涨价仅用24h内精准快照，过期/聚合不能驱动；纯利润修复可豁免竞品但方向必须向上；profit_repair目标<=现价直接跳过；低综合分亏损品也要能利润修复；current<floor时允许≤10%向上中间步骤，向下穿floor仍禁。
【验收】18品生产只读评分0阻断；36个目标价代回0失败；旧08:00 LLM调价和run-price已关闭，PROMO_AUTO_DECISION整改期false。`,
  },
  {
    title: "61N 全量重提副作用实证（2026-10-24）：主图/视频/富内容恢复与OEM落空",
    scenario: "sop",
    content: `【事故】为补OEM 7324，attributes/update imported但字段不落；全量/v3/product/import又出现primary_image空、complex_attributes视频被清，评级100→82。即使task imported零错误也不代表属性完整。
【恢复】①/v1/product/pictures/import用原始主图URL恢复，响应is_primary=true+state=imported；②原Ozon视频URL下载到本地，后台媒体→添加视频→上传→保存→发送审核，约10分钟评级回100；③富内容三处去Yamaha后重新校验通过。
【结论】OEM 7324增量和全量两通道均未落库，停止重试，OE继续由标题/标签/简介承载。全量重提前必须dump全属性/图/视频/价格，复杂属性也不能只凭imported判断成功。`,
  },
  {
    title: "备份恢复演练与凭据轮换实证（2026-10-24）",
    scenario: "ops",
    content: `【备份】pg_dump maxBuffer必须Infinity（Node v24下0也会被1MiB SIGTERM）；DB连接失败/任一表查询失败即失败并删除部分文件；fallback必须真实gzip，不能文件存在就报成功。
【恢复】新建临时库导入新备份，ozon_orders=3、sku_1688_mapping=37、promo_competitor_prices=1255、promo_pricing_history=196、promo_competitor_links=34、promo_audit_log=839，与生产一致；临时库和明文删除。加密备份解密后仍需gunzip再psql。
【凭据】服务器密码/ONZO API Key随机轮换；Seller API先新建验证再删旧；Performance新建108243845验证可用，旧98932307因Direct归因未重绑暂留，禁止在未改绑前停用。`,
  },
  {
    title: "CPO真实费率与低利润处置（2026-10-24）",
    scenario: "pricing",
    content: `【后台实证】全店CPO=23%覆盖18品；61N精选=35%。两条近期均0推广订单。自然成交仅61N、35X1126低于10%底价，其他8品应退出CPS而非盲目涨价。
【动作】两条CPO均关闭；精选添加列表只有61N，其他品无有效销售数据无准入，不能恢复全店广告。61N首轮772.77→850₽、35X首轮2407.68→2648₽，单次≤10%，min_price同步保护。CPC历史平均53.54₽不可恢复。
【看板】GET /api/promo/operations-board?days=30，真实浏览/加购/下单/取消/妥投/价格/min_price/库存与分组，Analytics失败502，orderedRevenueRub不是实收或净利润。`,
  },
];
(async () => {
  if (!API_KEY) throw new Error("API_KEY 未读到");
  for (const e of entries) {
    const resp = await fetch("https://huashangshangmao.top/api/rag/playbook", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": API_KEY }, body: JSON.stringify({ ...e, author: "kb-agent" }) });
    console.log(resp.status, e.title.slice(0, 42), (await resp.text()).slice(0, 120));
  }
})();
