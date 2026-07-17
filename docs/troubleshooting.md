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
检查 `DEEPSEEK_API_KEY`/`GLM_API_KEY` → 查看 token 配额 `GET /api/stats/llm`

## Redis 断连
`docker exec onzo-redis redis-cli -a $REDIS_PASSWORD PING` → `docker compose restart redis`

## 磁盘满
`df -h` → `POST /api/ops/cleanup` → `docker system prune -f`
