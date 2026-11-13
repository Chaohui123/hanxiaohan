# ONZO 自用代理 · 使用速查（2026-10-07 建成，已端到端验证）

> 下次新会话读这一篇就够，不用重新摸索。状态：**已装好可用**。

## 当前状态（已完成）
- 服务端：RackNerd San Jose VPS（192.236.171.95）Xray v25.8.3，VLESS+Reality 运行中（systemd 自启）
- Windows 客户端：**v2rayN 已安装在 `D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe`**，节点「ONZO-Proxy-SanJose」已预配好；代理服务地址为 `127.0.0.1:10808`，**系统代理按需开启，不宣称常驻开启**
- iOS：扫 `assets/proxy-qrcode.png` 二维码导入（Shadowrocket/Streisand/Sing-Box，需外区 Apple ID）
- 实测：YouTube HTTP 200、t.me HTTP 302、出口 IP=192.236.171.95
- **2026-10-18 换 IP + 住宅链路**：旧 IP `192.236.171.80` 在国内 22/80/443 全超时（海外 check-host 正常）→ RackNerd Change IP 支付 $3（Invoice #25834111，支付宝 CNY20.71）换到 `192.236.171.95`。NodeMaven 静态住宅（账号 584001555@qq.com，订单 `999038f8-3482-48ff-83e1-da98a9cf8466`，3 个美国 IP：`89.185.79.222` / `37.19.64.56` / `92.240.217.169`，$12.45/30天）第一出口 `89.185.79.222` 已挂到 Xray outbound `residential-us-1`；Google/YouTube/Reddit 与 `api.ipify.org` 走住宅 IP，其余流量走 VPS。实测本地代理出口 `api.ipify.org=89.185.79.222`、Google 204、YouTube/Reddit 200、5MB 下载约 438KB/s。住宅代理密码不写文档，在 NodeMaven 订单 Details 查看。
- **2026-10-18 OpenAI 路由补强与备用 IP 实测**：`openai.com`、`chatgpt.com`、`api.openai.com`、`auth.openai.com`、`oaistatic.com`、`oaiusercontent.com` 等 11 个域名使用独立优先规则。curl 对 3 个住宅 IP 均返回 403 是 Cloudflare 浏览器校验假阴性；真实浏览器实测：P1 `89.185.79.222` 正常、P2 `37.19.64.56` 正常、P3 `92.240.217.169` 的 ChatGPT 正常但 OpenAI 卡“请稍候”。最终 OpenAI/ChatGPT 固定走 `residential-us-2`（P2），Google/YouTube/Reddit 仍走 `residential-us-1`（P1）。验证标题：OpenAI 首页正常、ChatGPT 首页正常、`api.openai.com/v1/models` 返回 401（未带 key 的正常 API 响应）。
- **2026-10-18 TikTok 路由 + QUIC 修复 + 手机区域一致性（完整验证方案）**：`tiktok.com`、`tiktokv.com`、`tiktokcdn.com`、`musical.ly`、`isnssdk.com`、`tiktokd.org`、`tiktokd.net`、`byteoversea.com`、`ttwstatic.com`、`ttlivecdn.com`、`ibyteimg.com`、`ibytesdk.com`、`tiktokminis.us` 等 20 个域名走独立规则 `residential-us-3`（P3 `92.240.217.169`），与 Google/OpenAI 分 IP 隔离。手机 App 仍不稳定时的根因之一是 TikTok QUIC/UDP 443 不能穿过 HTTP 住宅代理；已在 Xray routing 最前面加 `network=udp + port=443 → blackhole` 强制回退 TCP。日志实证：TikTok 核心域名均按 SNI 命中 `residential-us-3`，未见裸 IP 泄漏；`sf-connect.tiktokminis.us` 曾走 direct，已补入。**最终闭环**：用户把手机时区和语言改为美国后 TikTok 正常——TikTok 检测链路必须同时满足「住宅 IP + QUIC 拦截 + 手机时区/语言/SIM 区域一致性」。
- **2026-11-05 Claude P3 路由试验（2026-11-06 已由 P1 方案替代）**：原 Claude/Anthropic 8 个域名与 OpenAI 共用 `residential-us-2`（P2），现已拆成独立规则并切换到 `residential-us-3`（P3 `92.240.217.169`）；OpenAI/ChatGPT 仍走 P2，Google/YouTube 仍走 P1，TikTok 与 Claude 共用 P3。Xray 配置测试通过、服务 active，日志实证 `claude.ai`、`api.anthropic.com`、`assets-proxy.anthropic.com` 按新规则命中。P1/P3 的真实浏览器均出现 Cloudflare 安全验证，未再出现“地区不支持”；安全验证与地区限制是不同问题，不宣称登录态或桌面端已验证。`api.anthropic.com` 返回404（服务在线）、OpenAI API 401（未带 key 正常）、Google 204，Ozon/1688 直连正常。服务端改前备份 `/usr/local/etc/xray/config.json.bak-claude-us1-20261105-094646` 与 `.bak-claude-us3-20261105-095011`。临时候选配置必须以 `.json` 结尾，否则 `xray run -test` 报 `Failed to get format`，线上配置不会被替换。操作脚本 `temp/racknerd-add-claude.py`，审计模式 `CLAUDE_ROUTE_AUDIT=1`。
- **2026-11-06 Claude 当前方案：P1 + 独立干净 Chrome（登录结果待用户验证）**：用户确认本周期免费 Swap 已用完，不执行整单换 IP；官方 [Change IP](https://docs.nodemaven.com/isp/change-ip) 也说明 Swap 会替换订单全部 IP，不能只换 P1。Claude/Anthropic 8 域名已从 P3 切回独立 `residential-us-1`（P1 `89.185.79.222`），其他出口不变，Xray 测试通过且 active；日志实证干净 Chrome 的 `claude.ai`、`assets.claude.ai`、`s-cdn.anthropic.com` 命中 P1。启动器 `tools/claude-clean-browser/start-claude-clean.cmd`，普通 Chrome 独立用户目录 `temp/claude-clean-browser/profile`，`--disable-extensions`、`--disable-sync`、仅该窗口 `--proxy-server=http://127.0.0.1:10808`，无远程调试、无反检测或指纹伪造插件，不影响原 Chrome，也不必开启系统代理。已实际启动 about:blank 验证并关闭测试进程，随后打开 Claude 登录页留给用户验证；P1 是否被 Anthropic 风控、账号能否登录均以用户实测为准，不预先宣称通过。服务端备份 `/usr/local/etc/xray/config.json.bak-claude-us1-20261106-085349`。复核时 `api.ipify.org=89.185.79.222`、Anthropic API 404、OpenAI API 401、Google 204，Ozon/1688 直连正常。
- **2026-11-06 Claude 登录复核中：P1 干净 Chrome 已被用户确认失败，当前改测 P3 + 独立干净 Edge**：上一条 P1 方案不再视为可用登录方案。新增 `tools/claude-clean-browser/start-claude-clean-edge.cmd` 与桌面 `Claude Edge 干净浏览器.lnk`，使用普通 Edge 独立目录 `temp/claude-clean-edge-browser/profile`、无扩展/同步/远程调试、仅该窗口代理。Edge 启动器对 `Program Files (x86)` 使用 `C:\Progra~2` 短路径，避免 CMD 括号解析失败。Claude 8 域名当前为 `residential-us-3`，备份 `/usr/local/etc/xray/config.json.bak-claude-us3-20261106-091712`，Xray active，日志确认 `claude.ai` 与 `assets-proxy.anthropic.com` 命中 P3。本轮要求用户用**邮箱验证码**而非 Google 登录，避免 Claude P3 与 Google P1 双出口引入额外变量；结果仍待用户实测。若 P3 也失败，现有三条 IP 均不再盲目重试，免费 Swap 已用完，只能等待续期、单独购买新订单或联系 Anthropic 支持。
- **2026-11-06 Outlook 与 Claude 统一 P3**：用户说明使用 Outlook 邮箱接收验证码，已将 `outlook.com`、`hotmail.com`、`live.com`、`office.com`、`office365.com`、`office.net`、`microsoftonline.com`、`msauth.net`、`msftauth.net`、`msidentity.com`、`outlookcdn.com` 加入 Claude 所在 P3 规则，共19个域名；不把整个 Microsoft 或 Google 改线。已在干净 Edge 打开 Outlook，Xray 日志实证 `outlook.live.com`、`outlook.office365.com`、`login.microsoftonline.com`、`login.live.com`、`aadcdn.msauth.net` 均走 `residential-us-3`。Outlook 首页301、Anthropic API404、OpenAI API401、Google204，其他线路不变。配置备份 `/usr/local/etc/xray/config.json.bak-claude-us3-20261106-092310`。
- **2026-11-06 Claude/Outlook 当前切换新购 P4（登录结果待用户验证）**：P1/P3 经用户实测均无法完成 Claude 登录后，用户购买1个美国 ISP IP/30天（$5）独立订单，新出口 `residential-us-4` / `178.171.5.143`，不覆盖 P1/P2/P3，Google、OpenAI、TikTok 线路不变。Claude 与 Outlook 共19个域名已从 P3 切到 P4，Xray 配置测试通过并 active；VPS 经 P4 请求 `api.ipify.org` 返回 `178.171.5.143`，本机 `claude.ai`、`outlook.live.com`、`api.anthropic.com` 日志均命中 P4。OpenAI API401、Google204、Ozon307/1688 200直连正常。连接凭据仅由剪贴板注入，不写入本文或审计日志；远程临时脚本已删除。备份 `/usr/local/etc/xray/config.json.bak-claude-us4-20261106-095901`，操作脚本 `temp/racknerd-add-claude.py`，`CLAUDE_P4_TEST=1` 验证出口，`CLAUDE_ROUTE_AUDIT=1` 读取命中日志。已在原干净 Edge profile 重新打开 Claude 登录页供用户验证，不预先承诺新 IP 一定通过 Anthropic 风控。
- **2026-11-06 Claude 登录环境公开规则与环境审计（不作指纹伪造）**：官方 [Troubleshoot Claude error messages](https://support.claude.com/en/articles/12466728-troubleshoot-claude-error-messages) 对通用登录错误只公开三项：不要使用 VPN、禁用浏览器扩展、清除缓存和 Cookie，再检查状态页；未公开操作系统、屏幕、字体、DNS、WebGL 等具体风控权重，不能把第三方指纹清单当作 Claude 官方规则。[状态页](https://status.claude.com/) 当日全部 Operational，无事故。环境为 Windows 11 build26200、2560×1440、真实系统时间/中国时区，Cookie/硬件加速配置项未修改（默认值），干净 profile 无扩展清单、无远程调试、无 `disable-gpu` 或反检测参数。发现 Edge `144.0.3719.92` 明显低于微软官方 Stable `157.0.4341.42`（[官方 release notes](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-stable-channel)），故改用机器现有干净 Chrome `156.0.8078.80` + P4，而不是继续用旧 Edge。保持默认字体、分辨率、真实 GPU/WebGL、Cookie 持久化，不伪造 UA/系统/时区，不注入指纹脚本，不在新 IP 会话中反复清 Cookie。Claude 与 Outlook 仍统一 P4，Xray 按域名转发并日志确认 P4，不把随机第三方 DNS 测试当作浏览器泄漏证据；官方“不要使用 VPN”与当前代理方案存在明确合规/风控边界，新 IP 和环境整理不保证登录通过。
- **2026-11-06 P4 免费 Swap 当前 IP（登录待用户验证）**：用户确认首次 P4 `178.171.5.143` 仍无法登录，授权使用新购单 IP 订单的免费 Swap。已在该订单详情确认“1 free swap”并执行，确认弹窗明确不可取消；仅这一个新订单更换 IP，原三 IP 订单未动。Swap 后 IP=`178.171.5.45`、端口/用户名/密码不变，订单显示0次剩余。P4 outbound 地址已更新，19个 Claude/Outlook 域名仍走 `residential-us-4`，Xray active；VPS 实测出口 `178.171.5.45`，本机 `claude.ai`、`outlook.live.com`、`api.anthropic.com` 均命中 P4，OpenAI401/Google204不变。改前备份 `/usr/local/etc/xray/config.json.bak-claude-us4-20261106-113623`，干净 Chrome 已重新打开登录页；凭据未写入文档或日志，剪贴板与远程临时脚本已清理。新 IP 只证明链路和路由正确，不承诺登录成功。
- **2026-11-06 新购 P4 订单已取消自动续费**：仅取消1个新 IP 订单（$5/30天）的续费，原三 IP 订单不动。订单取消说明明确当前 IP 保留至 **2026-12-06 09:50 UTC**，到期后停用且再次购买会分配新 IP。完成后订阅按钮由 `Cancel` 变为 `Resume`，证明自动续费已关闭；P4 当前仍可用，出口实测 `178.171.5.45`，路由未改。若到期前需要保留同一 IP，只能重新 Resume；不要误以为取消会立即断线或退款。
- **2026-11-06 P4 到期前一天自动回退 P3 已部署**：在 RackNerd 建立一次性 systemd timer `onzo-claude-fallback-p3.timer`，执行时间为 **2026-12-05 09:50 UTC（北京时间17:50）**，即 P4 到期前24小时。服务 `onzo-claude-fallback-p3.service` 调用 `/usr/local/sbin/onzo-claude-fallback-p3.py`，仅移动当前19个 Claude/Outlook 域名：P4→P3，其他线路不动；执行前要求 P4 规则仍完整包含19域名，否则拒绝部分切换。候选配置以 `.json` 运行 Xray 测试，真实执行时先备份再替换和重启，结果写 `/var/lib/onzo/claude-fallback-p3-last-run.json`。部署时干跑 `configTestPassed=true`、`activeConfigChanged=false`，timer 回读 `enabled/active`，NEXT=`Sat 2026-12-05 09:50:00 UTC`；当前 P4 出口仍为 `178.171.5.45`。部署脚本 `temp/ops-exec/deploy-claude-p4-p3-timer-20261106.py`，审计 `temp/ops-exec/claude-p4-p3-timer-20261106.json`。该定时器在服务器上运行，不依赖聊天会话或本机开机。
- **2026-11-07 Codex 桌面端 `Reconnecting / error sending request` 排障**：v2rayN 与10808监听正常，显式代理 `api.openai.com=401`、`chatgpt.com=200`，但 Windows `ProxyEnable=0`，桌面应用未继承 `gpt-assist.sh` 的代理变量。开启系统代理并执行 `temp/refresh-proxy.ps1` 后，`codex login status` 为 ChatGPT，`bash temp/gpt-assist.sh terra "只回复 OK，不调用任何工具。"` 真实返回 OK。`failed to refresh available models: request timed out` 是后台模型列表刷新失败，不影响生成。桌面应用若仍显示旧错误，完全退出后重开以丢弃旧连接；Codex 使用时开启系统代理，任务结束按项目规则关闭，不能靠反复重试代替网络配置。

## 日常使用
- **启动代理服务**：双击 `D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe` 启动 v2rayN；这只启动代理服务，**不等于必须开启系统代理**。如需开机自启，把快捷方式放进 `shell:startup`。
- **按需开关系统代理**：浏览器访问外网前检查并开启；任务用完立即选择“清除系统代理”或退出 v2rayN，并执行 `temp/refresh-proxy.ps1` 即时刷新。再次需要时选择“设置系统代理”。
- **API 请求**：按 `AGENTS.md` 规则由脚本显式指定 `127.0.0.1:10808`，不必因此开启系统代理；国内站和国内 API 保持直连。

## 节点信息（受控配置）
- 可导入链接、UUID、PublicKey 等凭据**不再写入本文档**，只从受控客户端配置、VPS/供应商订单或受控密钥存储读取。禁止从本文或历史截图恢复、转发节点。
- 曾写入文档的凭据应按既有轮换流程更新；新值只在受控位置维护，不在文档中回显。

## 关键坑（排障实录，别再踩）
1. **Reality 的 dest/SNI 不能用 www.microsoft.com**（其 TLS 栈与 Reality 握手借用不兼容→全量握手失败）；**dl.google.com 可用**
2. 密钥须经典 x25519 格式（v25 `xray x25519` 输出）；v26 输出带 ML-KEM 后量子字段易混淆
3. v2rayN 7.x 节点存 SQLite：`guiConfigs/guiNDB.db`（ProfileItem 表）；设置存 `guiConfigs/guiNConfig.json`（SysProxyType=1=开系统代理）
4. VPS 服务端：`ssh root@192.236.171.95`（密码在 RackNerd 开通邮件），`systemctl restart xray` 重启，配置 `/usr/local/etc/xray/config.json`
5. RackNerd ctrl 面板可换 IP（$3/次），换 IP 只改节点 Address，其他参数不变
6. **智能应用控制（SAC）会拦 v2rayN**（无企业签名；SAC 评估转强制后突然拦截，2026-10-09 实证）：解除=注册表 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` 的 `VerifiedAndReputablePolicyState` 改 0（**可逆**，备份在 temp/sac-backup.txt；设置 UI 里关则不可逆）→ **必须重启生效**。免重启不可行：CiTool --remove-policy 对 SAC 平台签名策略报 0x80070005（受保护）。重启后验证：Get-MpComputerStatus 的 SmartAppControlState=Off + curl -x 127.0.0.1:10808 google 200
7. **VK 对该节点 IP 风控**（2026-10-08 实证）：vkvideo.ru/vk.ru 只剩骨架屏/零宽字符，YouTube 同节点正常——VK 操作（发片/评论）改用户手机端做，或换 IP 再试
8. **代理慢先分端测速；BBR 可缓解但非根治**（2026-10-14 实证）：手机端慢时，同一节点 PC 代理仅约 12KB/s、VPS 直连约 16.4MB/s，说明主因是国际链路而非手机。VPS 原为 cubic+pfifo_fast，启用 BBR+fq 后首次代理测速约 265KB/s、复测约 64KB/s，提升明显但仍有波动。已在 `/etc/sysctl.d/99-onzo-bbr.conf` 持久化 `net.core.default_qdisc=fq`、`net.ipv4.tcp_congestion_control=bbr`，并执行 `sysctl --system`；无需重启 Xray。若仍慢，优先考虑 RackNerd 换 IP（$3/次）或换机房，换 IP 后必须同步所有客户端 Address。
9. **明文 HTTP 住宅代理不能从国内直连 Google/YouTube**（2026-10-18 实证）：NodeMaven HTTP 代理本身可用，但国内直连时 `CONNECT google.com:443` 目标域名明文暴露，被链路 reset；必须嵌套在 VLESS/Reality 隧道内，由 VPS 服务端再转发到住宅 IP。配置位置：VPS `/usr/local/etc/xray/config.json` 的 outbound `residential-us-1` + routing domain 规则；改完执行 `/usr/local/bin/xray run -test -config ...` 再 `systemctl restart xray`。
10. **TikTok/字节系 App 完整检测链=住宅 IP+QUIC 拦截+手机区域一致性**（2026-10-18 完整验证）：VLESS+Reality 可把 UDP 封装进隧道，但 Xray HTTP outbound 只支持 TCP，UDP 443 到住宅出口会失败，App 表现为“网络连接不稳定”。在 routing 最前面加 `{type:"field", network:"udp", port:"443", outboundTag:"block"}`，outbounds 加 `blackhole`，强制回退 TCP。日志排障看 `sniffed domain` 是否命中目标出口；大量裸 IP 直连才提示 App 自有 DNS/HTTPDNS。**最后还必须检查手机时区/语言/SIM 区域一致性**——本次用户改为美国后 TikTok 才正常，这是完整验证过的最终方案。

## 当前用途
- YouTube Shorts 上传（站外分发，UTM 链接见 `temp/utm-links-2026-10-04.md`）
- TG 群组、Reddit 采集、Yandex/Google SEO 查询

## 生产服务器容器内代理（daily-learning 墙外源，2026-10-10 新增）

- **背景**：生产服务器直连 Reddit/Telegram/YouTube 被墙（000 超时实证）→ 墙外源统一经 Xray 客户端连本 VPS（VLESS+Reality，参数同上节）。实际代理入口以 `LEARNING_PROXY_URL` 为准；当前生产配置为 `socks5://172.28.0.1:10808`，本机 v2rayN 常用 127.0.0.1:10808（socks5/http）。
- **代码**：`apps/api-services/src/jobs/daily-learning.ts` 墙外源（Reddit/Telegram/YouTube）统一走 `proxyFetch()`（undici `ProxyAgent`，依赖 undici ^8.11.2；socks5 scheme 需 undici ≥6.7，实测 8.x 构造与连接 OK——Node 会打 `ExperimentalWarning: SOCKS5 proxy support is experimental`，功能可用）。`apps/api-services/src/services/official-evidence.ts` 复用同一通道，仅抓取白名单内的 Google 官方文档。
- **env 配置**（容器 .env）：
  - `LEARNING_PROXY_URL`（可选，默认 `socks5://127.0.0.1:10808`；socks5 握手异常时改 `http://127.0.0.1:10809`）
  - `KNOWLEDGE_OFFICIAL_PROXY_URL`（知识门禁官方取证可选覆盖；未配置时复用 `LEARNING_PROXY_URL`，不用于 DeepSeek/Ozon；官方取证或审核失败的知识拒入）
  - `LEARNING_TG_CHANNELS`（可选，默认 `ozon_seller,marketplace_ru`；频道 404 失效时换同类型频道名即可，逗号分隔，`@`/`s/` 前缀有无均可）
  - `LEARNING_YT_CHANNELS`（可选，默认空=YouTube 源不抓；逗号分隔频道 ID，UC 开头，频道页 URL `/channel/` 后一段）
  - `LEARNING_REDDIT_SUBS`（已有，默认加了 `snowmobile,boating` 垂直品类 sub）
- **fail-open 纪律**：代理不可用/被墙时墙外源记 warn 跳过（返回空数组），不炸整个学习周期；墙内源（B站/vc.ru/habr/retail.ru/seller-edu）保持直连不动。

## 竞品公开数据专用代理（2026-10-27）

- **独立配置**：生产采集容器用 `OZONE_CHANNEL=translate` 和 `OZONE_TRANSLATE_PROXY_URL=http://172.28.0.1:10809`。`172.28.0.1` 是 `onzo_onzo-network` 的宿主机网关；不要在容器里写 `127.0.0.1`。宿主机直接测试才用 `http://127.0.0.1:10809`。`OZONE_PROXY_URL` 仅作浏览器回退代理，不与该 HTTP 通道混填。
- **边界**：通道是经 Google translate 的公开页面代理，不是 Ozon 官方 API 或稳定性承诺，不传 Seller Client ID、API Key、买家或订单数据。SKU、标题、规格、可售状态和价格必须逐条核验；`cardPrice` 与 `priceRegular` 分开记录。HTTP 403/404、验证码、聚合页和字段缺失不得伪装成有效数据。
- **接口兼容**：`ProxyAgent` 与 `fetch` 必须都来自项目现有 `undici` 依赖；不能把它传给 Node 原生 fetch，否则出现 `UND_ERR_INVALID_ARG / invalid onRequestStart`。HTTP/SOCKS 代理只注入该公开采集请求，不能全局污染 Ozon Seller API、DeepSeek 或国内请求。
- **反爬失败不能误判通过**：服务器直连及旧代理出现 `Похоже, нет соединения` / `Antibot Captcha` 均不得记为验证通过。主通道采用上述第三方 JSON 通道，不依赖本机 WebBridge；缺评分时可由容器内 Chromium 走 Ozon 直连补取，但失败必须保留 NULL，不能覆盖主通道的有效价格。浏览器从 Debian 镜像源安装并以 `OZONE_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` 显式指定，避免 Playwright CDN 停滞；每日调度见 `docs/current-pipeline.md` 的竞品监控双链路。
