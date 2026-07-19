#!/bin/bash
# ============================================================
# ONZO Caddy SSL 证书修复脚本
# 在服务器 124.221.11.222 上执行
# ============================================================
set -e

echo "=== ONZO Caddy SSL 修复 ==="
echo ""

# 1. 检查 Caddy 状态
echo "Step 1: 检查 Caddy 容器状态..."
if docker ps --format '{{.Names}}' | grep -q "onzo-caddy"; then
    echo "  ✅ Caddy 容器正在运行"
else
    echo "  ❌ Caddy 容器未运行！"
    echo "  启动中..."
    cd /data/onzo
    docker compose --profile production up -d caddy
    sleep 5
fi

# 2. 查看最近的 Caddy 日志
echo ""
echo "Step 2: Caddy 最近日志 (检查证书错误)..."
docker logs onzo-caddy --tail 20 2>&1 | grep -iE "cert|tls|error|acme" || echo "  (无相关错误日志)"

# 3. 尝试续期证书
echo ""
echo "Step 3: 尝试续期 Let's Encrypt 证书..."
if docker exec onzo-caddy caddy renew 2>&1; then
    echo "  ✅ 证书续期成功"
else
    echo "  ⚠️ 续期失败，尝试强制重建..."

    # 4. 停止 Caddy，清理证书数据
    echo ""
    echo "Step 4: 清理证书缓存并重建..."
    cd /data/onzo
    docker compose stop caddy

    # 备份旧证书（以防万一）
    if [ -d "/data/onzo/caddy/data" ]; then
        cp -r /data/onzo/caddy/data /data/onzo/caddy/data.bak.$(date +%Y%m%d_%H%M%S)
        echo "  📦 旧证书已备份"
    fi

    # 清理证书
    rm -rf /data/onzo/caddy/data/caddy/certificates/*

    # 重启 Caddy
    docker compose --profile production up -d caddy
    sleep 10

    echo "  ✅ Caddy 已重启，正在自动申请新证书..."
fi

# 5. 验证 HTTPS
echo ""
echo "Step 5: 验证 HTTPS..."
sleep 5
if curl -sk "https://localhost/health" --max-time 10 2>/dev/null | grep -q "status"; then
    echo "  ✅ HTTPS 恢复正常！"
else
    echo "  ⚠️ HTTPS 仍不可用，请检查:"
    echo "    1. DNS: nslookup huashangshangmao.top (必须解析到本机IP)"
    echo "    2. 防火墙: ufw status (确保 80/443 开放)"
    echo "    3. 端口占用: netstat -tlnp | grep -E ':80 |:443 '"
    echo "    4. Caddy 日志: docker logs onzo-caddy --tail 50"
fi

echo ""
echo "=== 修复完成 ==="
echo ""
echo "验证命令:"
echo "  curl -s https://huashangshangmao.top/health"
echo "  curl -s https://huashangshangmao.top/ -o /dev/null -w '%{http_code}'"
