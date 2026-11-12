#!/usr/bin/env bash
# 在广州中转服务器（81.71.94.90，Ubuntu 24.04，2核4G）上一键部署 Chatwoot 在线客服（开源，中文界面）。
# 功能：网页聊天挂件（贴一段 JS 到任意网页）、多客服坐席、会话分配、快捷回复、手机 App（iOS/Android 填自建地址）。
# 用法（服务器上，用户 ubuntu 或 root；重跑同一条命令 = 升级到最新版，数据和密钥保留）：
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/setup-chatwoot.sh -o /tmp/cw.sh && bash /tmp/cw.sh
# 地址：已跑过 setup-https-ip.sh（caddy-ip 在运行）→ https://IP:8443；否则 http://IP:3000。
# 不碰 frps（7000/10000-10100）、8099、80；只新增 3000、8443 两个端口。
# 可选环境变量：PORT=3000 HTTPS_PORT=8443 IP=x.x.x.x CW_IMAGE=chatwoot/chatwoot:latest
set -euo pipefail
red() { echo -e "\033[31m$*\033[0m" >&2; }
green() { echo -e "\033[32m$*\033[0m"; }
trap 'red "失败：第 $LINENO 行出错，上面是原因。修好后重跑同一条命令即可。"' ERR
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
PORT="${PORT:-3000}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
CW_IMAGE="${CW_IMAGE:-chatwoot/chatwoot:latest}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine}"
DIR=/opt/chatwoot

IP="${IP:-$(curl -fsS --max-time 5 https://myip.ipip.net/s 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)}"
IP=$(echo "$IP" | tr -d '[:space:]')
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { red "取不到公网 IP，请用 IP=x.x.x.x bash /tmp/cw.sh 指定"; exit 1; }
echo "公网 IP：$IP"

port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }

echo "== 1/6 内存：没有 swap 就加 2G（4G 内存跑 Chatwoot + frps 留余量）"
if [ "$(free -m | awk '/^Swap:/{print $2}')" -lt 1000 ]; then
  if [ ! -f /swapfile ]; then
    $SUDO fallocate -l 2G /swapfile || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048
    $SUDO chmod 600 /swapfile
    $SUDO mkswap /swapfile >/dev/null
  fi
  $SUDO swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi
free -m | sed -n '1,3p'

echo "== 2/6 安装 Docker（走腾讯云 apt 源）+ 国内镜像加速"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
fi
$SUDO mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ] || ! grep -q registry-mirrors /etc/docker/daemon.json; then
  $SUDO tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
EOF
  $SUDO systemctl restart docker
fi
$SUDO systemctl enable docker >/dev/null 2>&1 || true
DOCKER="$SUDO docker"
$DOCKER compose version

echo "== 3/6 生成配置 $DIR（已有则保留密钥和数据）"
$SUDO mkdir -p "$DIR"
cd "$DIR"
HTTPS=0
if systemctl is-active --quiet caddy-ip 2>/dev/null && [ -f /etc/caddy/Caddyfile ]; then HTTPS=1; fi
if [ "$HTTPS" = 1 ]; then URL="https://$IP:$HTTPS_PORT"; else URL="http://$IP:$PORT"; fi
if ! $DOCKER compose ps --status running 2>/dev/null | grep -q rails; then
  port_busy "$PORT" && { red "端口 $PORT 被占用，换一个：PORT=3100 bash /tmp/cw.sh"; ss -ltnp | grep -E ":$PORT\s" >&2 || true; exit 1; }
fi
rnd() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }
if [ ! -f .env ]; then
  $SUDO tee .env >/dev/null <<EOF
SECRET_KEY_BASE=$(rnd 128)
POSTGRES_PASSWORD=$(rnd 32)
REDIS_PASSWORD=$(rnd 32)
EOF
  $SUDO chmod 600 .env
fi
# 每次重跑都刷新这些非密钥项
$SUDO sed -i '/^\(FRONTEND_URL\|CW_IMAGE\|PG_IMAGE\|REDIS_IMAGE\|PORT\)=/d' .env
printf 'FRONTEND_URL=%s\nCW_IMAGE=%s\nPG_IMAGE=%s\nREDIS_IMAGE=%s\nPORT=%s\n' "$URL" "$CW_IMAGE" "$PG_IMAGE" "$REDIS_IMAGE" "$PORT" | $SUDO tee -a .env >/dev/null

$SUDO tee docker-compose.yml >/dev/null <<'EOF'
x-base: &base
  image: ${CW_IMAGE}
  restart: always
  env_file: .env
  environment:
    RAILS_ENV: production
    NODE_ENV: production
    INSTALLATION_ENV: docker
    DEFAULT_LOCALE: zh_CN
    FORCE_SSL: "false"
    ENABLE_ACCOUNT_SIGNUP: "false"
    RAILS_LOG_TO_STDOUT: "true"
    LOG_LEVEL: warn
    ACTIVE_STORAGE_SERVICE: local
    POSTGRES_HOST: postgres
    POSTGRES_USERNAME: postgres
    POSTGRES_DATABASE: chatwoot
    REDIS_URL: redis://redis:6379
    # 省内存：单进程 + 少线程
    WEB_CONCURRENCY: "0"
    RAILS_MAX_THREADS: "5"
    SIDEKIQ_CONCURRENCY: "5"
    MALLOC_ARENA_MAX: "2"
  volumes:
    - storage:/app/storage

services:
  postgres:
    image: ${PG_IMAGE}
    restart: always
    environment:
      POSTGRES_DB: chatwoot
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    command: postgres -c shared_buffers=128MB -c max_connections=50
    volumes:
      - pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 30

  redis:
    image: ${REDIS_IMAGE}
    restart: always
    command: ["sh", "-c", "redis-server --requirepass \"$$REDIS_PASSWORD\" --maxmemory 128mb --maxmemory-policy noeviction"]
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    volumes:
      - redis:/data

  rails:
    <<: *base
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    entrypoint: docker/entrypoints/rails.sh
    command: ["bundle", "exec", "rails", "s", "-p", "3000", "-b", "0.0.0.0"]
    ports:
      - "${PORT}:3000"

  sidekiq:
    <<: *base
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    command: ["bundle", "exec", "sidekiq", "-C", "config/sidekiq.yml"]

volumes:
  storage:
  pg:
  redis:
EOF
$DOCKER compose config -q

echo "== 4/6 拉镜像（约 1GB，国内镜像加速，几分钟）"
$DOCKER compose pull

echo "== 5/6 初始化/升级数据库并启动"
$DOCKER compose up -d postgres redis
$DOCKER compose run --rm rails bundle exec rails db:chatwoot_prepare
$DOCKER compose up -d --remove-orphans

if [ "$HTTPS" = 1 ]; then
  echo "== 6/6 HTTPS：Caddy 加 $HTTPS_PORT → 127.0.0.1:$PORT（沿用 IP 证书）"
  $SUDO mkdir -p /etc/caddy/conf.d
  $SUDO tee /etc/caddy/conf.d/chatwoot.caddy >/dev/null <<EOF
https://$IP:$HTTPS_PORT {
  tls {
    issuer acme {
      profile shortlived
    }
  }
  reverse_proxy 127.0.0.1:$PORT
}
EOF
  grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/conf.d/*.caddy' | $SUDO tee -a /etc/caddy/Caddyfile >/dev/null
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  $SUDO systemctl reload caddy-ip
else
  echo "== 6/6 跳过 HTTPS（没检测到 caddy-ip；想要 HTTPS 先跑 setup-https-ip.sh 再重跑本脚本）"
fi
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q active; then
  $SUDO ufw allow "$PORT/tcp" >/dev/null; $SUDO ufw allow "$HTTPS_PORT/tcp" >/dev/null
fi

echo "等服务起来（最多 3 分钟）"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api" || true)
  if [ "$code" = 200 ]; then
    if [ "$HTTPS" = 1 ]; then
      for j in $(seq 1 30); do curl -fsS -o /dev/null --max-time 5 "$URL/api" 2>/dev/null && break; sleep 3; done
    fi
    echo
    green "已就绪：$URL"
    echo "第一次打开会进入「创建管理员」页面，填邮箱和密码即可（只这一次，之后关闭公开注册）。"
    [ "$HTTPS" = 1 ] && echo "HTTPS 证书没签下来时可先用 http://$IP:$PORT"
    echo "内存占用："; $DOCKER stats --no-stream --format '  {{.Name}}  {{.MemUsage}}'
    exit 0
  fi
  sleep 3
done
red "服务 3 分钟内没起来，看日志：cd $DIR && sudo docker compose logs --tail 80 rails"
exit 1
