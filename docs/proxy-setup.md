# ONZO 自用代理 · 使用速查（2026-10-07 建成，已端到端验证）

> 下次新会话读这一篇就够，不用重新摸索。状态：**已装好可用**。

## 当前状态（已完成）
- 服务端：RackNerd San Jose VPS（192.236.171.80）Xray v25.8.3，VLESS+Reality 运行中（systemd 自启）
- Windows 客户端：**v2rayN 已安装在 `D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe`**，节点「ONZO-Proxy-SanJose」已预配好，**系统代理已开（127.0.0.1:10808）**
- iOS：扫 `assets/proxy-qrcode.png` 二维码导入（Shadowrocket/Streisand/Sing-Box，需外区 Apple ID）
- 实测：YouTube HTTP 200、t.me HTTP 302、出口 IP=192.236.171.80

## 日常使用
- **开机自启**：v2rayN 需手动启动（桌面双击 `D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe` 即可，节点和系统代理设置都已存好，启动即生效）。如要真开机自启：把 v2rayN.exe 快捷方式放进 `shell:startup`（Win+R 输入回车打开的文件夹）
- **临时关代理**：v2rayN 托盘图标右键 → 系统代理 → 清除系统代理（或退出 v2rayN，系统代理随之关闭）
- **再开**：托盘右键 → 系统代理 → 设置系统代理

## 节点信息（丢了可照此重建）
- v2rayN 导入链接（Ctrl+V 导入）：
```
vless://ffab43d5-cd1f-4369-a7d2-c74dcc94bf00@192.236.171.80:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=dl.google.com&fp=chrome&pbk=oyHTRMllyC9MlBEb5CmJqWDhXesJs_yU-uoxnhV68CI&sid=4e7e4abc&type=tcp#ONZO-Proxy-SanJose
```
- UUID: ffab43d5-cd1f-4369-a7d2-c74dcc94bf00
- PublicKey: oyHTRMllyC9MlBEb5CmJqWDhXesJs_yU-uoxnhV68CI ｜ ShortId: 4e7e4abc ｜ SNI: dl.google.com ｜ Flow: xtls-rprx-vision

## 关键坑（排障实录，别再踩）
1. **Reality 的 dest/SNI 不能用 www.microsoft.com**（其 TLS 栈与 Reality 握手借用不兼容→全量握手失败）；**dl.google.com 可用**
2. 密钥须经典 x25519 格式（v25 `xray x25519` 输出）；v26 输出带 ML-KEM 后量子字段易混淆
3. v2rayN 7.x 节点存 SQLite：`guiConfigs/guiNDB.db`（ProfileItem 表）；设置存 `guiConfigs/guiNConfig.json`（SysProxyType=1=开系统代理）
4. VPS 服务端：`ssh root@192.236.171.80`（密码在 RackNerd 开通邮件），`systemctl restart xray` 重启，配置 `/usr/local/etc/xray/config.json`
5. RackNerd ctrl 面板可换 IP（$3/次），换 IP 只改节点 Address，其他参数不变
6. **智能应用控制（SAC）会拦 v2rayN**（无企业签名；SAC 评估转强制后突然拦截，2026-10-09 实证）：解除=注册表 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` 的 `VerifiedAndReputablePolicyState` 改 0（**可逆**，备份在 temp/sac-backup.txt；设置 UI 里关则不可逆）→ **必须重启生效**。免重启不可行：CiTool --remove-policy 对 SAC 平台签名策略报 0x80070005（受保护）。重启后验证：Get-MpComputerStatus 的 SmartAppControlState=Off + curl -x 127.0.0.1:10808 google 200
7. **VK 对该节点 IP 风控**（2026-10-08 实证）：vkvideo.ru/vk.ru 只剩骨架屏/零宽字符，YouTube 同节点正常——VK 操作（发片/评论）改用户手机端做，或换 IP 再试

## 当前用途
- YouTube Shorts 上传（站外分发，UTM 链接见 `temp/utm-links-2026-10-04.md`）
- TG 群组、Reddit 采集、Yandex/Google SEO 查询

## 生产服务器容器内代理（daily-learning 墙外源，2026-10-10 新增）

- **背景**：生产服务器直连 Reddit/Telegram/YouTube 被墙（000 超时实证）→ api-services 容器内装 Xray 客户端连本 VPS（VLESS+Reality，参数同上节），监听 127.0.0.1:**10808=socks5** / **10809=http** 双协议。
- **代码**：`apps/api-services/src/jobs/daily-learning.ts` 墙外源（Reddit/Telegram/YouTube）统一走 `proxyFetch()`（undici `ProxyAgent`，依赖 undici ^8.11.2；socks5 scheme 需 undici ≥6.7，实测 8.x 构造与连接 OK——Node 会打 `ExperimentalWarning: SOCKS5 proxy support is experimental`，功能可用）。
- **env 配置**（容器 .env）：
  - `LEARNING_PROXY_URL`（可选，默认 `socks5://127.0.0.1:10808`；socks5 握手异常时改 `http://127.0.0.1:10809`）
  - `LEARNING_TG_CHANNELS`（可选，默认 `ozon_seller,marketplace_ru`；频道 404 失效时换同类型频道名即可，逗号分隔，`@`/`s/` 前缀有无均可）
  - `LEARNING_YT_CHANNELS`（可选，默认空=YouTube 源不抓；逗号分隔频道 ID，UC 开头，频道页 URL `/channel/` 后一段）
  - `LEARNING_REDDIT_SUBS`（已有，默认加了 `snowmobile,boating` 垂直品类 sub）
- **fail-open 纪律**：代理不可用/被墙时墙外源记 warn 跳过（返回空数组），不炸整个学习周期；墙内源（B站/vc.ru/habr/retail.ru/seller-edu）保持直连不动。
