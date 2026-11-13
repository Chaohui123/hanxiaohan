# ONZO 故障排查手册

## 容器崩溃
`docker ps -a` → `docker logs --tail 50 onzo-api` → `docker compose --profile production --env-file .env.production up -d api-services`

## Ozon 401
按 `operations-manual.md` 的凭据排查节核对 Client ID、Seller API Key 和 `store_configs` 是否一致；需要轮换时先验证新 Key，再更新受控配置并回读，禁止把旧 Key 复制到文档或聊天中。

## Ozon 429
`docker logs --tail 200 onzo-api` → 确认接口与限流状态 → 降频/退避并等待恢复；重启不能提高配额，也不作为重置计数器的首选方案。

## COS 上传失败
`docker logs onzo-api | grep COS` → 检查密钥 → `POST /api/images/retry-dead-letter`

## SQLite 锁（仅 standalone）
standalone 出现 `SQLITE_BUSY` 时按本地部署日志和单写连接排查，不用生产裸机 `systemctl` 命令。当前 production 主库是 PostgreSQL，锁/超时按 `operations-manual.md` 的 PG 排查节处理。

## LLM 报错
检查 `DEEPSEEK_API_KEY`/`KIMI_API_KEY` → 查看 token 配额 `GET /api/stats/llm`

## Redis 断连
`docker exec onzo-redis redis-cli -a $REDIS_PASSWORD PING` → `docker compose restart redis`

## 磁盘满
`df -h /var/lib/docker` → 大头通常是 buildkit 构建缓存（曾达 45G）：`docker builder prune -af --keep-storage 10g` → 再 `docker system prune -af`（**禁 --volumes**，会删 PG/Redis 数据卷；执行前确认关键容器在运行，否则停止中的容器及其镜像会被一并删掉，需重建）

## API 502（Caddy 反代失败）
先看 Caddy 日志：`docker logs onzo-caddy | grep 502` → `lookup api-services: server misbehaving` = api 容器不存在/崩溃 → `docker compose --profile production --env-file .env.production up -d --build api-services`；`no space left on device` = 磁盘满，按上一条处理
