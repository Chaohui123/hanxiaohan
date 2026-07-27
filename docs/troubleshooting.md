# ONZO 故障排查手册

## 容器崩溃
`docker ps -a` → `docker logs --tail 50 onzo-api` → `docker compose --env-file .env up -d api-services`

## Ozon 401
检查 `.env` 中 `OZON_API_KEYS` 是否过期 → 刷新 token → 重启服务

## Ozon 429
`grep "429" /tmp/onzo.log` → 降低 sync 频率 → 重启 API 重置计数器

## COS 上传失败
`docker logs onzo-api | grep COS` → 检查密钥 → `POST /api/images/retry-dead-letter`

## SQLite 锁
`grep "SQLITE_BUSY" /tmp/onzo.log` → `systemctl restart onzo-api`

## LLM 报错
检查 `DEEPSEEK_API_KEY`/`KIMI_API_KEY` → 查看 token 配额 `GET /api/stats/llm`

## Redis 断连
`docker exec onzo-redis redis-cli -a $REDIS_PASSWORD PING` → `docker compose restart redis`

## 磁盘满
`df -h /var/lib/docker` → 大头通常是 buildkit 构建缓存（曾达 45G）：`docker builder prune -af --keep-storage 10g` → 再 `docker system prune -af`（**禁 --volumes**，会删 PG/Redis 数据卷；执行前确认关键容器在运行，否则停止中的容器及其镜像会被一并删掉，需重建）

## API 502（Caddy 反代失败）
先看 Caddy 日志：`docker logs onzo-caddy | grep 502` → `lookup api-services: server misbehaving` = api 容器不存在/崩溃 → `docker compose --profile production --env-file .env.production up -d --build api-services`；`no space left on device` = 磁盘满，按上一条处理
