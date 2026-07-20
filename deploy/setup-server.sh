#!/bin/bash
set -e
# 通用服务器初始化 + 部署脚本（与具体服务器无关）
# 域名通过 .env.production 的 CADDY_DOMAIN 配置，不硬编码
echo "========================================="
echo "  ONZO 一键部署脚本"
echo "  用法: 上传 onzo.zip 到 /data/onzo/ 后运行本脚本"
echo "  域名: 部署前在 .env.production 配置 CADDY_DOMAIN"
echo "========================================="

echo ""
echo ">>> [1/7] 系统初始化..."
apt update -y && apt upgrade -y
apt install -y curl wget vim git htop net-tools ufw unzip gnupg

echo ""
echo ">>> [2/7] 配置防火墙..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable

echo ""
echo ">>> [3/7] 安装Docker..."
if ! command -v docker &> /dev/null; then
    # 阿里云 docker-ce apt 源（GPG 签名校验；不使用 curl|sh 方式，避免供应链风险）
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt update -y
    apt install -y docker-ce docker-ce-cli containerd.io
    systemctl start docker
    systemctl enable docker
fi
apt install -y docker-compose-plugin

echo ""
echo ">>> [4/7] 创建目录..."
mkdir -p /data/onzo/{uploads,dead-letter,logs,postgres,redis,caddy}/data
mkdir -p /data/onzo/caddy/data
mkdir -p /data/onzo/app

echo ""
echo ">>> [5/7] 解压代码..."
if [ -f /data/onzo/onzo.zip ]; then
    rm -rf /data/onzo/app/*
    unzip -o /data/onzo/onzo.zip -d /data/onzo/app/
    echo "代码解压完成"
else
    echo "未找到onzo.zip，请先上传"
    exit 1
fi

echo ""
echo ">>> [6/7] 创建环境变量..."
cd /data/onzo/app
# 首次部署：以模板生成 .env.production，填入真实密钥后再启动
if [ ! -f .env.production ]; then
    cp .env.example .env.production
    echo "已生成 .env.production — 必填: OZON_CLIENT_IDS, OZON_API_KEYS, API_KEY,"
    echo "  KIMI_API_KEY, DEEPSEEK_API_KEY, GRAFANA_PASSWORD, POSTGRES_PASSWORD,"
    echo "  REDIS_PASSWORD, N8N_ENCRYPTION_KEY。填写后重新运行本脚本"
    exit 1
fi
cp .env.production .env

echo ""
echo ">>> [7/7] 启动服务..."
# compose 中所有服务都声明了 profiles，必须显式指定 profile，否则启动 0 个容器
docker compose --profile production --env-file .env.production up -d --build
sleep 30
docker compose ps

echo ""
echo "========================================="
echo "  部署完成！"
# 从 .env.production 读域名提示，未配置则提示占位
DOMAIN=$(grep -E '^CADDY_DOMAIN=' .env.production 2>/dev/null | cut -d= -f2-)
echo "  访问: https://${DOMAIN:-<未配置 CADDY_DOMAIN>}  (Caddy 配置: docker/caddy/Caddyfile)"
echo "  日志: docker compose logs -f api-services"
echo "========================================="
