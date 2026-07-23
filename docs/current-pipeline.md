# ONZO 当前链路状态（2026-07-23 快照）

> 本文档记录**当前实际跑通**的链路与配置，与 `architecture.md`（设计目标）区分。
> 目的：任何新会话/新人只读本文 + `deployment.md` 即可接手运营，不依赖历史对话。
> 状态变更后请同步更新本文。

---

## 一、上架链路闭环（已全线跑通，均实测验证）

```
选品（季节因子接入 finalScore）
  → 飞书 listing 命令触发
  → 1688 素材抓取（本机 WebBridge 工具，见第四节）
  → AI 文案营销化 + 定价拆解（定价明细随通知发出）
  → Ozon API 上架
  → import-status-sync 回填真实 product_id（采购匹配的关键闭环）
  → Webhook 事件驱动出单（/ozon/webhook → ozon_webhook_log → drain 消费）
  → 采购匹配（凭 product_id 关联 1688 货源）
```

关键提交（可回溯实现细节）：

| 环节 | Commit | 说明 |
|---|---|---|
| 选品季节因子 | `258d860` | 季节因子计入 finalScore |
| listing 断链修复 | `068dc5a` | 飞书 listing 命令链路修复 |
| product_id 回填 | `3965a2a` + `f466caf` | 实测 task_5164731660 → product_id 5601249994 |
| 文案/定价通知 | `05632a5` | 文案营销化 + 定价拆解随通知发出 |
| 1688 素材工具 | `2d8e812` | `scripts/download-1688-assets.cjs` |

Webhook 架构细节见 `webhook-architecture.md`。Webhook URL `https://huashangshangmao.top/ozon/webhook` 已在 Ozon 卖家后台登记成功（注意：登记校验要求响应体符合 Ozon 模板格式，已实现）。

## 二、飞书双机器人（已可用）

- **ops-agent（运维）** 与 **promo-agent（推广）** 是两个独立飞书 App，消息带 `[运维]` / `[推广]` 前缀以区分来源。
- 群聊中 @ 机器人才会响应（私聊直接响应）；chatId 配置于服务器环境变量，不写进仓库。
- 凭据（App ID / App Secret）仅存于服务器 `.env` 与本地 `.env`，**任何文档/代码中不得出现明文**。

## 三、自动部署（deploy-watch）

详见 `deployment.md` 的 deploy-watch 一节。要点：

- 服务器 cron 每 5 分钟检测 `origin/main`，有新 commit 自动构建部署。
- **不要并行手动 `docker compose build`**——与 deploy-watch 的构建并发会撞坏 buildkit 缓存（已发生两次）。构建统一走 deploy-watch，或确认其空闲后手动执行。

## 四、1688 素材抓取（本机工具）

脚本：`scripts/download-1688-assets.cjs`

```bash
node scripts/download-1688-assets.cjs <1688链接或offerId> [输出根目录]
```

- **前提（缺一不可）**：用户本机 Windows；Kimi WebBridge daemon 运行于 `127.0.0.1:10086`；Chrome 扩展已连接。
- **流程**：打开商品页 → 滚动触发懒加载 → 页面内提取标题/价格/规格/全图/视频 → 带 Referer+UA 下载 → 生成 `manifest.json` 采购清单（原始 URL + 本地路径 + 规格参数，供出单后采购使用）。
- **输出**：`D:\下载\1688_<offerId>\{images,videos,manifest.json}`。
- **实测基线**（offer/891784406688）：视频 2/2 完整；主图含 1920×1920 高清；图成功率约 50%（1688 SKU 小图防盗链严格属预期损耗）；规格 22 条。
- **为什么不做成服务器端点**：WebBridge 运行在用户本机，服务器 api-services 无法触达。如需飞书触发，只能"服务器下单 → 本机跑脚本"两段式。
- **为什么不用官方"1688采购助手"插件弹窗**：其下载弹窗为 hover 触发 + 跨域 iframe + isTrusted 检测，自动化无法稳定展开，已放弃该路径。

## 五、已知未决项（不影响主链路，按需处理）

- 素材图成功率可通过"滚动到底再提取"进一步提升（未做，非必需）。
- `transition-logistics.test.ts` 的 importBilling 用例超时——既有问题，与近期改动无关。
- 飞书触发素材抓取的两段式串联（未做，需求待确认）。

## 六、安全备忘

- 以下凭据曾在即时通讯中明文传输，建议择机轮换：Kimi K3 API Key、飞书 App Secret、Ozon API Key。
- 服务器 API_KEY 已在换服务器时轮换过一次（值存于服务器 handover 文件，未进仓库）。
