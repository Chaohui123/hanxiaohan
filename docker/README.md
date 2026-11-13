# ONZO Docker 部署指南

> 2026-11-04 按 `docker-compose.yml` 复核。生产默认 PostgreSQL + pgvector、Redis、API、agents、Web 看板、Whisper 和 Caddy；standalone 不是当前生产方案。

## 部署前准备

- Docker 与 Docker Compose 插件。
- 受控的 `.env.production`，不要提交或打印其中的密钥。
- 生产所需的 PostgreSQL/Redis 密码、Ozon/Kimi/DeepSeek/API_KEY、Caddy 域名等配置；完整说明见 [部署手册](../docs/deployment.md)。
- 使用 Whisper 时准备只读挂载所需的本地 cookies 文件，不能将其提交到仓库。

```bash
git clone git@github.com:Chaohui123/hanxiaohan.git
cd hanxiaohan
cp .env.example .env.production
# 安全地填写 .env.production，再启动：
docker compose --profile production --env-file .env.production up -d
```

## Profile 边界

| Profile | 实际用途 |
|---|---|
| `production` | 当前生产基础栈，含 PostgreSQL、Redis、Caddy 和业务服务 |
| `standalone` | SQLite/无 PG、Redis 的本地或降级环境，不用于当前生产 |
| `full` | 带 `full` 标签的业务与监控服务；Caddy 只挂在 `production`，需要 HTTPS 时同时指定 `--profile production --profile full` |
| `monitoring` | 仅监控组件，不等于完整业务栈 |
| `tracing` | Jaeger  tracing |
| `n8n` | 可选可视化编排；按现行内建 scheduler 运行时不依赖它 |

启用可选 n8n：

```bash
docker compose --profile production --profile n8n --env-file .env.production up -d
```

不要再使用早期文档中的 `--profile full --profile production` 作为唯一标准命令，也不要把不带 profile 的 `docker compose up -d` 当成生产启动方式。按上表选择真实需要的服务。

## 服务与健康检查

| 服务 | 默认端口 | 说明 |
|---|---:|---|
| api-services | 3000 | ONZO API 与运营接口 |
| web-dashboard | 8080 | React/Vite 看板 |
| Caddy | 80/443 | 生产 HTTPS 入口 |
| n8n（可选） | 5678 | 可视化工作流 |

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

`/health` 只表示存活；`/ready` 还检查数据库、Redis、Ozon、磁盘和模型配置。部署验收必须检查 `/ready`，不能只看容器存在。

## 常用运维命令

```bash
# 日志
docker compose --env-file .env.production logs -f api-services

# 重建并启动 API；先确认 deploy-watch 没有并行构建
docker compose --profile production --env-file .env.production up -d --build api-services

# 手动触发内建备份；API_KEY 在容器环境中读取，不打印其值
docker compose --env-file .env.production exec -T api-services sh -c 'wget -qO- --header="X-API-Key: $API_KEY" --post-data="" http://127.0.0.1:3000/api/db/backup'

# 停止当前 Compose 项目；不删除数据卷
docker compose --env-file .env.production down
```

生产备份由 API 默认每 6 小时执行，输出 `pg_dump → .sql.gz[.enc]` 并持久化到 `app_data`。备份恢复、保留期和演练要求见 [运维手册](../docs/operations-manual.md)。

**禁止把 `docker compose down -v`、全量 `docker system prune -af` 或未经演练的一键恢复作为常规运维命令。** deploy-watch 自动部署及 Caddy 单文件挂载注意事项见 [部署手册](../docs/deployment.md)。

## 故障排查

- PostgreSQL/Redis 连接失败：先检查生产环境变量、容器健康和 `/ready`，不要按 SQLite 锁处理。
- 401：核对 `X-API-Key` 或对应 Ozon 凭据是否有效，不绕过鉴权。
- 429/公共采集通道失败：降频、退避并保留旧报告，不伪造全零数据。
- Caddy/HTTPS：检查域名、DNS、80/443、防火墙和 Caddy 日志。
- 更多当前处理方式见 [故障排查](../docs/troubleshooting.md)。
