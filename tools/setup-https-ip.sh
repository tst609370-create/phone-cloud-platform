#!/usr/bin/env bash
# 给中转服务器的公网 IP 挂 HTTPS（Let's Encrypt IP 证书，6 天有效，Caddy 自动续期），不需要域名。
# 每个 frp 业务端口 P（10000-10100）对应 HTTPS 端口 P+10000：
#   http://81.71.94.90:10000  →  https://81.71.94.90:20000
# HTTPS 下浏览器才给原生视频解码和麦克风，手机浏览器也能流畅出画。
# 用法（服务器上，用户 ubuntu 或 root）：
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/setup-https-ip.sh -o /tmp/https.sh && bash /tmp/https.sh
# 前提：80 端口空闲且公网可达（证书验证用），腾讯云防火墙放行 80、20000-20100。
set -euo pipefail
red() { echo -e "\033[31m$*\033[0m" >&2; }
trap 'red "失败：第 $LINENO 行出错，上面是原因。修好后重跑同一条命令即可。"' ERR
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
FIRST="${FIRST:-10000}"
LAST="${LAST:-10100}"
OFFSET="${OFFSET:-10000}"
CADDY_VER="${CADDY_VER:-2.11.4}"

IP="${IP:-$(curl -fsS --max-time 5 https://myip.ipip.net/s 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)}"
IP=$(echo "$IP" | tr -d '[:space:]')
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { red "取不到公网 IP，请用 IP=x.x.x.x bash /tmp/https.sh 指定"; exit 1; }
echo "公网 IP：$IP"

echo "== 1/4 安装 Caddy（需要 2.10 以上才支持 IP 证书）"
need_install=1
if command -v caddy >/dev/null; then
  v=$(caddy version | grep -oE '[0-9]+\.[0-9]+' | head -1)
  if [ "$(printf '%s\n2.10\n' "$v" | sort -V | head -1)" = "2.10" ]; then need_install=0; fi
fi
if [ "$need_install" = 1 ]; then
  tmp=$(mktemp -d)
  ok=0
  for u in "https://caddyserver.com/api/download?os=linux&arch=amd64" \
           "https://ghfast.top/https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_linux_amd64.tar.gz" \
           "https://gh-proxy.com/https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_linux_amd64.tar.gz"; do
    echo "下载 $u"
    if curl -fL --connect-timeout 15 --max-time 600 -o "$tmp/dl" "$u"; then
      if tar -tzf "$tmp/dl" >/dev/null 2>&1; then tar -xzf "$tmp/dl" -C "$tmp" caddy; else mv "$tmp/dl" "$tmp/caddy"; fi
      chmod +x "$tmp/caddy"
      if "$tmp/caddy" version >/dev/null 2>&1; then ok=1; break; fi
    fi
  done
  [ "$ok" = 1 ] || { red "Caddy 下载失败"; exit 1; }
  $SUDO install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
caddy version

echo "== 2/4 生成配置（$FIRST-$LAST → $((FIRST+OFFSET))-$((LAST+OFFSET))）"
CONF=$(mktemp)
{
  echo "{"
  echo "  default_sni $IP"
  echo "}"
  for p in $(seq "$FIRST" "$LAST"); do
    cat <<EOF
https://$IP:$((p+OFFSET)) {
  tls {
    issuer acme {
      profile shortlived
    }
  }
  reverse_proxy 127.0.0.1:$p
}
EOF
  done
  echo "import /etc/caddy/conf.d/*.caddy"   # 其他服务（如 setup-chatwoot.sh）放这里，重跑本脚本不丢
} > "$CONF"
$SUDO mkdir -p /etc/caddy/conf.d /var/lib/caddy
[ -n "$(ls /etc/caddy/conf.d/*.caddy 2>/dev/null)" ] || echo "# 占位，保证 import 有文件可匹配" | $SUDO tee /etc/caddy/conf.d/00-empty.caddy >/dev/null
$SUDO install -m 644 "$CONF" /etc/caddy/Caddyfile
rm -f "$CONF"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

echo "== 3/4 systemd 服务 caddy-ip（开机自启，证书自动续期）"
if ss -ltnp 2>/dev/null | grep -E ':80\s' | grep -vq caddy; then
  red "80 端口被其他程序占用（证书验证要用）："; ss -ltnp | grep -E ':80\s' >&2; exit 1
fi
$SUDO tee /etc/systemd/system/caddy-ip.service >/dev/null <<EOF
[Unit]
Description=Caddy HTTPS for public IP (frp ports)
After=network-online.target
[Service]
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
LimitNOFILE=65535
AmbientCapabilities=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable caddy-ip >/dev/null 2>&1
$SUDO systemctl restart caddy-ip
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q active; then
  $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow "$((FIRST+OFFSET)):$((LAST+OFFSET))/tcp" >/dev/null
fi

echo "== 4/4 等证书签发（最多 90 秒）"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 "https://$IP:$((FIRST+OFFSET))/" 2>/dev/null || \
     curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "https://$IP:$((FIRST+OFFSET))/" 2>/dev/null | grep -qE '^[2-5][0-9][0-9]$'; then
    echo
    echo -e "\033[32m已就绪：https://$IP:$((FIRST+OFFSET))  （原 http://$IP:$FIRST）\033[0m"
    echo "规则：原来 http 端口 + $OFFSET 就是 https 地址；原 http 地址照常可用。"
    exit 0
  fi
  sleep 3
done
red "证书还没签下来。看日志：sudo journalctl -u caddy-ip -n 50 --no-pager"
red "常见原因：腾讯云防火墙没放行 80 或 $((FIRST+OFFSET))-$((LAST+OFFSET))，或 80 被占用。"
exit 1
