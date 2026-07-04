# ONZO Docker 部署指南

## 一键启动

```bash
# 1. 克隆项目
git clone https://github.com/Chaohui123/hanxiaohan.git && cd hanxiaohan

# 2. 配置环境变量（复制模板 + 填入真实值）
cp .env.production .env.production.local
nano .env.production.local  # 替换所有 CHANGE_ME

# 3. 启动（基础模式：仅 API 服务 + SQLite）
docker compose up -d

# 4. 验证
curl http://localhost:3000/health
# → {"status":"ok"}

# 5. 启动（生产模式：含 Caddy HTTPS）
docker compose --profile production up -d

# 6. 启动（全栈模式：PostgreSQL + Redis + Caddy）
docker compose --profile full --profile production up -d
```

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| api-services | 3000 | ONZO API + 运营看板 |
| caddy (--profile production) | 80/443 | HTTPS 反向代理 |
| n8n (外部) | 5678 | 工作流引擎（独立部署） |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ENCRYPTION_KEY` | ✅ | AES-256 加密主密钥，64 字符 hex |
| `ENCRYPTION_SALT` | ✅ | 加密盐值，64 字符 hex |
| `GLM_API_KEY` | ✅ | 智谱 AI 密钥 |
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek AI 密钥 |
| `OZON_CLIENT_IDS` | ✅ | Ozon 卖家 Client ID |
| `OZON_API_KEYS` | ✅ | Ozon API 密钥 |
| `API_KEY` | ✅ | ONZO API 鉴权密钥 |
| `N8N_PASSWORD` | ✅ | n8n 登录密码 |
| `N8N_ENCRYPTION_KEY` | ✅ | n8n 加密密钥 |
| `CADDY_DOMAIN` | 可选 | HTTPS 域名（生产必填） |
| `POSTGRES_PASSWORD` | 可选 | PostgreSQL 密码（full profile） |
| `REDIS_PASSWORD` | 可选 | Redis 密码（full profile） |

## 常用命令

```bash
# 查看日志
docker compose logs -f api-services

# 重启服务
docker compose restart api-services

# 进入容器调试
docker compose exec api-services sh

# 手动备份数据库
docker compose exec api-services curl -X POST http://localhost:3000/api/db/backup

# 停止并清理
docker compose down -v
```

## 健康检查

```bash
# 存活
curl http://localhost:3000/health

# 就绪（含 DB + Ozon + AI 检查）
curl http://localhost:3000/ready

# 运营看板
open http://localhost:3000/
```

## 常见问题

### 构建失败 `pnpm install` 报错
```bash
# 清除缓存重试
docker compose build --no-cache api-services
```

### 端口 3000 被占用
```bash
# 修改 .env.production.local 中的 PORT 和 API_SERVICE_PORT
```

### SQLite 数据库锁
```bash
# 查看当前写入队列
docker compose exec api-services curl http://localhost:3000/api/task/queue/stats
```

### Caddy HTTPS 证书失败
```bash
# 确认 CADDY_DOMAIN 已正确设置且 DNS 指向服务器 IP
# 确认端口 80/443 已在防火墙开放
docker compose logs caddy
```

### 图片上传失败
```bash
# COS 配置检查
docker compose exec api-services curl http://localhost:3000/api/stats/cos
```
