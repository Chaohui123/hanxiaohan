# ONZO 运维速查命令

## 重启
```bash
docker compose --env-file .env up -d api-services
docker compose restart caddy
systemctl restart onzo-api          # 裸机时
```

## 日志
```bash
docker compose logs -f --tail 100 api-services
docker compose logs -f --tail 50 ops-agent
tail -f /var/log/onzo-api.log       # systemd 日志
```

## 数据库
```bash
docker exec onzo-postgres psql -U onzo -d onzo_prod -c "SELECT * FROM ozon_orders LIMIT 5"
```

## 备份/恢复
```bash
ls -lh /root/onzo/data/backups/
gunzip -c backup.sql.gz | docker exec -i onzo-postgres psql -U onzo onzo_prod
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
docker system prune -af
```
