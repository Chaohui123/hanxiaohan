# ONZO 运维手册 v1.0

> 部署架构：Docker (可选) + Caddy HTTPS + SQLite + COS  
> 服务器：腾讯云 Lighthouse `lhins-d76pb230` (124.221.11.222)  
> Node v22 / pnpm / tsx 直接运行

---

## 一、服务宕机 / 容器崩溃快速重启

### 1.1 快速检查

```bash
# 存活检查
curl http://localhost:3000/health

# 就绪检查（含 DB + Ozon + 模型密钥）
curl http://localhost:3000/ready

# 查看进程
ps aux | grep "tsx.*index"

# 查看最近日志
tail -50 /tmp/onzo.log
```

### 1.2 重启步骤（直接运行模式）

```bash
# 杀掉旧进程
pkill -f "tsx.*index"

# 启动
cd /root/onzo/apps/api-services
nohup npx tsx src/index.ts > /tmp/onzo.log 2>&1 &

# 等 5 秒验证
sleep 5 && curl http://localhost:3000/health
```

### 1.3 重启步骤（Docker 模式）

```bash
cd /root/onzo
docker compose down
docker compose up -d --build
docker compose logs -f api-services
```

### 1.4 自动恢复（crontab 心跳）

```bash
# 每分钟检测，挂了自动拉起
crontab -e
# 添加：
* * * * * curl -s --connect-timeout 5 http://localhost:3000/health || (pkill -f "tsx.*index"; cd /root/onzo/apps/api-services && nohup npx tsx src/index.ts > /tmp/onzo.log 2>&1 &)
```

### 1.5 系统资源检查

```bash
free -h              # 内存
df -h                # 磁盘
ss -tlnp | grep 3000 # 端口占用
top -bn1 | head -5   # CPU
```

---

## 二、Ozon API 错误处理

### 2.1 401 Unauthorized

**现象**：`POST /process/manual` 返回 `"Ozon API error: 401"`

**原因**：API 密钥过期或未配置

**排查**：
```bash
# 检查 .env 中的密钥
grep OZON_ /root/onzo/.env

# 直接测试 Ozon API
curl -X POST https://api-seller.ozon.ru/v1/warehouse/list \
  -H "Client-Id: 你的ClientId" \
  -H "Api-Key: 你的ApiKey" \
  -H "Content-Type: application/json" \
  -d "{}"
```

**解决**：
1. 登录 Ozon 卖家后台 → 设置 → API 密钥
2. 如果密钥过期，生成新密钥
3. 更新 `D:/Onzo/.env`（本地）和 `/root/onzo/.env`（服务器）
4. 重启服务

### 2.2 429 Rate Limit

**现象**：连续请求后返回 `429 Too Many Requests`，熔断器自动 OPEN

**原因**：Ozon API 限制 30次/分钟，令牌桶耗尽

**排查**：
```bash
# 查看熔断器状态
tail -50 /tmp/onzo.log | grep "CircuitBreaker"
```

**自动恢复**：
- 熔断器 30 秒后自动 HALF_OPEN → 探测成功 → CLOSE
- 批量重跑：`POST /api/task/deadletter/retry-batch` （选 `api_error` 过滤）

**手动恢复**：
```bash
# 重启服务会重置熔断器
pkill -f "tsx.*index" && cd /root/onzo/apps/api-services && nohup npx tsx src/index.ts > /tmp/onzo.log 2>&1 &
```

### 2.3 图片拉取失败

**现象**：`"All image uploads failed — URL import, browser download, and direct fetch all exhausted"`

**原因**：
| 情况 | 说明 |
|------|------|
| 1688 防盗链 | 图片 URL 有 Referer 校验，Ozon 服务器无法下载 |
| 图片格式 | Ozon 不接受 SVG / 超小图 / 非标准格式 |
| 公网不可达 | `localhost` 或内网 URL 对 Ozon 不可见 |

**解决**：
```
方案 A（推荐）：部署到公网后，图片通过 https://你的域名/tmp-images/xxx.jpg 暴露给 Ozon
方案 B：使用 COS 上传 → 获取公网 URL → 用 COS URL 导入 Ozon
方案 C：手动上架时提供可公网访问的图片 URL
```

---

## 三、COS 上传与存储

### 3.1 上传失败

**现象**：`[COS] Upload failed` 或返回 `isDeadLetter: true`

**排查**：
```bash
# 检查 COS 配置
grep COS_ /root/onzo/.env

# 检查死信队列
ls /root/onzo/dead-letter/ 2>/dev/null | wc -l
```

**解决**：
1. 验证 `COS_SECRET_ID` / `COS_SECRET_KEY` 是否正确
2. 检查 COS Bucket 是否存在且可读写
3. 确认 `COS_REGION` 与 Bucket 所在地一致
4. COS 控制台检查是否欠费/超额

**重试死信**：
```bash
curl -X POST http://localhost:3000/api/images/retry-dead-letter
```

### 3.2 存储空间满

**排查**：
```bash
# 查看 COS 控制台用量
# 或通过 API：
curl http://localhost:3000/api/stats/cos
```

**解决**：
1. COS 控制台 → 生命周期管理 → 设置自动删除 30 天前图片
2. 清理本地死信目录：`rm -rf /root/onzo/dead-letter/*`
3. 扩容 COS（按量付费，无需手动操作）

---

## 四、SQLite 数据库运维

### 4.1 数据库锁

**现象**：请求返回 `SQLITE_BUSY` 或超时

**原因**：并发写入冲突（SQLite 单写锁）

**排查**：
```bash
# 查看是否有长时间运行的写入
tail -50 /tmp/onzo.log | grep "transaction\|ROLLBACK\|SQLITE_BUSY"
```

**自动保护**：
- `serializedWrite()` 序列化所有写入操作
- `withTransaction()` 使用 `BEGIN IMMEDIATE` 获取写锁
- 单次事务超时由 Express 全局 120s timeout 控制

**手动解决**：
```bash
# 1. 备份当前数据库
cp /root/onzo/data/onzo.db /root/onzo/data/onzo.db.bak

# 2. 检查数据库完整性
sqlite3 /root/onzo/data/onzo.db "PRAGMA integrity_check;"

# 3. 如果损坏，从备份恢复
cp /root/onzo/data/backups/onzo-*.db /root/onzo/data/onzo.db
```

### 4.2 备份

**自动备份**（已内置）：
- 每 6 小时自动备份到 `./data/backups/`
- 保留最近 7 天
- 使用 `VACUUM INTO` 原子备份（不锁库）

**手动备份**：
```bash
curl -X POST http://localhost:3000/api/db/backup
# → 备份到 /root/onzo/data/backups/onzo-2026-07-04T....db
```

**查看备份**：
```bash
curl http://localhost:3000/api/db/backups
```

**异地备份**（可选）：
```bash
# 配置 rclone remote 后
bash /root/onzo/scripts/backup-remote.sh
```

### 4.3 恢复

```bash
# 1. 停止服务
pkill -f "tsx.*index"

# 2. 恢复
cd /root/onzo/data
cp onzo.db onzo.db.crash-$(date +%Y%m%d-%H%M%S)
cp backups/onzo-目标时间.db onzo.db

# 3. 重启
cd /root/onzo/apps/api-services && nohup npx tsx src/index.ts > /tmp/onzo.log 2>&1 &
```

### 4.4 数据库维护

```bash
# 清理旧任务（7天前）
sqlite3 /root/onzo/data/onzo.db "
  DELETE FROM task_queue WHERE status IN ('done','failed') AND completed_at < datetime('now','-7 days');
  VACUUM;
"

# 查看表大小
sqlite3 /root/onzo/data/onzo.db "
  SELECT name, COUNT(*) as rows FROM sqlite_master
  WHERE type='table'
  GROUP BY name ORDER BY rows DESC;
"
```

---

## 五、LLM Token 与 AI 错误

### 5.1 Token 超限熔断

**现象**：Pipeline 返回 `"Daily token limit (500000) exceeded"` 或 看板红色告警

**原因**：当日 Token 消耗超过 `LLM_DAILY_TOKEN_LIMIT`

**排查**：
```bash
curl http://localhost:3000/api/stats/llm
# → todayTokens: 498000 / 500000 (99%)
```

**临时解决**：
```bash
# 1. 修改 .env 提高限额
echo "LLM_DAILY_TOKEN_LIMIT=1000000" >> /root/onzo/.env

# 2. 重启生效
pkill -f "tsx.*index" && cd /root/onzo/apps/api-services && nohup npx tsx src/index.ts > /tmp/onzo.log 2>&1 &
```

**永久方案**：
- 检查是否有 prompt 过长导致不必要消耗
- 检查 `MAX_AI_CONCURRENCY` 是否过高（默认 5，可降到 3）
- 运营看板 → Token 卡片 → 关注日消耗趋势

### 5.2 DeepSeek 翻译报错

**现象**：`"Translation failed: DeepSeek API error: 401/429/500"`

**排查**：
```bash
# 检查密钥
grep DEEPSEEK /root/onzo/.env

# 测试 DeepSeek API
curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

**常见错误**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `401` | 密钥无效或过期 | 去 platform.deepseek.com 重新生成 |
| `429` | 并发超限 | 降低 `MAX_AI_CONCURRENCY` 或等待 |
| `500/503` | DeepSeek 服务异常 | 等待 5 分钟自动恢复 |
| `timeout` | 网络超时 | 检查服务器能否访问 api.deepseek.com |

### 5.3 K3 Vision 报错

**现象**：`"OCR failed: K3 API error: 429"`

**排查**：
```bash
# 检查密钥
grep KIMI /root/onzo/.env

# K3 额度检查
# 登录 platform.moonshot.cn → 控制台 → 查看剩余额度
```

**解决**：
- K3 按量计费，429 为并发限流或额度不足
- 自动重试最多 2 次，间隔 1s/2s
- 降低 `MAX_AI_CONCURRENCY` 可减少触发

### 5.4 类目匹配返回 0

**现象**：`"categoryId": 0` 或 `"Category matching returned invalid ID (0)"`

**原因**：DeepSeek 在截断的类目树中找不到匹配

**自动恢复**：
1. 首次失败 → 自动 retry（更严格的 prompt）
2. 二次失败 → `searchCategoryTree()` 程序化关键词搜索
3. 三次失败 → `confidence: 0`，pipeline 记录错误继续

**手动处理**：查看 `POST /api/process/manual` 返回的 `errors` 数组，确认具体原因。

### 5.5 汇率服务异常

**现象**：看板显示 `stale: true` 或 `reliable: false`

**排查**：
```bash
curl http://localhost:3000/api/stores/fx
# → {"rate":11.4,"cached":true,"stale":false,"reliable":true}
```

**状态含义**：

| 字段 | 含义 | 行动 |
|------|------|------|
| `stale: true` | 缓存 >24h | 检查服务器能否访问 open.er-api.com |
| `reliable: false` | 双源偏差>5% 或缓存>48h | **Pipeline 已自动阻断上架**，等汇率恢复 |

---

## 附录

### A. 快速诊断命令汇总

```bash
# 一键收集诊断信息
echo "=== Health ===" && curl -s http://localhost:3000/health
echo "=== Ready ===" && curl -s http://localhost:3000/ready
echo "=== Queue ===" && curl -s http://localhost:3000/api/task/queue/stats
echo "=== Token ===" && curl -s http://localhost:3000/api/stats/llm
echo "=== FX ===" && curl -s http://localhost:3000/api/stores/fx
echo "=== DB ===" && ls -lh /root/onzo/data/onzo.db
echo "=== Disk ===" && df -h /
echo "=== Memory ===" && free -h
echo "=== Uptime ===" && uptime
```

### B. 重要文件路径

| 文件 | 路径 |
|------|------|
| 源码 | `/root/onzo/` |
| 环境变量 | `/root/onzo/.env` |
| 数据库 | `/root/onzo/data/onzo.db` |
| 备份目录 | `/root/onzo/data/backups/` |
| 运行日志 | `/tmp/onzo.log` |
| 死信目录 | `/root/onzo/dead-letter/` |
| COS 临时图 | `/root/onzo/data/tmp-images/` |

### C. 监控端点

| 端点 | 用途 | 告警条件 |
|------|------|---------|
| `/health` | 存活 | 非 200 |
| `/ready` | 就绪 | 任一 check 非 ok |
| `/api/dashboard` | 运营指标 | failed > 0 |
| `/api/stats/llm` | Token | todayTokens > 80% 限额 |
| `/api/stats/cos` | COS | 占比 > 80% |
| `/api/stores/fx` | 汇率 | reliable = false |
