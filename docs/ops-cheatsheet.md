# ONZO 运维速查命令

## 重启
```bash
docker compose --profile production --env-file .env.production up -d api-services
docker compose restart caddy
# systemctl restart onzo-api 仅历史裸机部署，禁止用于当前 Docker 生产
```

## 日志
```bash
docker compose logs -f --tail 100 api-services
docker compose logs -f --tail 50 ops-agent
# 不再使用 /tmp/onzo.log 或 /var/log/onzo-api.log 作为生产默认路径
```

## 数据库
```bash
docker exec onzo-postgres psql -U onzo -d onzo_prod -c "SELECT * FROM ozon_orders LIMIT 5"
```

## 备份/恢复
```bash
docker exec onzo-api ls -lh /app/data/backups
# 恢复先读 operations-manual.md 6.3：隔离解密演练、停写、保留现状快照；
# 禁止 gunzip 后直接倒灌正在使用的数据库。
```

## Redis
```bash
docker exec onzo-redis redis-cli -a $REDIS_PASSWORD PING
docker exec onzo-redis redis-cli -a $REDIS_PASSWORD INFO memory
```

## 健康
```bash
curl https://huashangshangmao.top/health
curl -H "X-API-Key: $API_KEY" https://huashangshangmao.top/api/diagnose
```

## 清理
```bash
curl -X POST -H "X-API-Key: $API_KEY" http://localhost:3000/api/ops/cleanup
docker builder prune -af --keep-storage 10g
# 不把 docker system prune -af 当常规操作；禁止 --volumes，先确认关键容器和备份。
```
