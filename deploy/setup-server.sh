#!/bin/bash
set -e
echo "========================================="
echo "  ONZO 一键部署脚本"
echo "  服务器: 124.221.11.222"
echo "  域名: 124-221-11-222.nip.io"
echo "========================================="

echo ""
echo ">>> [1/8] 系统初始化..."
apt update -y && apt upgrade -y
apt install -y curl wget vim git htop net-tools ufw unzip

echo ""
echo ">>> [2/8] 配置防火墙..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable

echo ""
echo ">>> [3/8] 安装Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    systemctl start docker
    systemctl enable docker
fi
apt install -y docker-compose-plugin

echo ""
echo ">>> [4/8] 创建目录..."
mkdir -p /data/onzo/{uploads,dead-letter,logs,postgres,redis,caddy}/data
mkdir -p /data/onzo/caddy/data
mkdir -p /data/onzo/app

echo ""
echo ">>> [5/8] 创建Caddy配置..."
mkdir -p /data/onzo/caddy
cat > /data/onzo/caddy/Caddyfile << 'CEOF'
124-221-11-222.nip.io {
    encode gzip zstd
    reverse_proxy /api/* api-services:3000
    reverse_proxy /tmp-images/* api-services:3000
    reverse_proxy /health api-services:3000
    reverse_proxy /metrics api-services:3000
    reverse_proxy /dashboard api-services:3000
    reverse_proxy api-services:3000
    log {
        output file /data/caddy/access.log
        level INFO
    }
}

http://124.221.11.222 {
    redir https://124-221-11-222.nip.io{uri} permanent
}
CEOF

echo ""
echo ">>> [6/8] 创建环境变量..."
cp /data/onzo/app/.env.production /data/onzo/app/.env 2>/dev/null || echo "将使用项目自带.env.production"

echo ""
echo ">>> [7/8] 解压代码..."
if [ -f /data/onzo/onzo.zip ]; then
    rm -rf /data/onzo/app/*
    unzip -o /data/onzo/onzo.zip -d /data/onzo/app/
    echo "代码解压完成"
else
    echo "未找到onzo.zip，请先上传"
    exit 1
fi

echo ""
echo ">>> [8/8] 启动服务..."
cd /data/onzo/app
docker compose up -d --build
sleep 30
docker compose ps

echo ""
echo "========================================="
echo "  部署完成！"
echo "  访问: https://124-221-11-222.nip.io"
echo "  日志: docker compose logs -f api-services"
echo "========================================="
