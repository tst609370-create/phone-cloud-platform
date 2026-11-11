#!/usr/bin/env bash
# 在一台新的 Ubuntu 22.04/24.04 服务器上装好 frps 公网中转（root 执行）：
#   curl -fsSL https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/setup-relay-server.sh | bash
#
# 做的事：
#   1. 开 BBR + fq 和更大的 TCP 缓冲：跨境高延迟、有丢包的链路上，BBR 比默认 cubic 稳得多。
#   2. 装最新版 frps，systemd 开机自启、崩溃自动重启。
#   3. frps 同时开 TCP 7000、KCP（UDP 7000）、QUIC（UDP 7002），客户端可按线路选协议。
#   4. 首次运行生成随机令牌，写在 /etc/frp/frps.toml（权限 600），重复运行保留原令牌。
#   5. ufw 只放行 22、7000、7002、10000-10100。
#   6. 最后打印令牌、监听状态和一次下载测速。
# 不碰任何其它服务；不往仓库或日志里写令牌。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/6 网络参数（BBR）"
cat > /etc/sysctl.d/90-phone-relay.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
net.core.rmem_default = 2097152
net.core.wmem_default = 2097152
EOF
modprobe tcp_bbr 2>/dev/null || true
sysctl --system >/dev/null
echo "拥塞控制：$(sysctl -n net.ipv4.tcp_congestion_control)"

echo "== 2/6 下载 frps"
apt-get update -qq && apt-get install -y -qq curl tar ufw ca-certificates >/dev/null
ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) A=amd64;; arm64) A=arm64;; *) echo "不支持的架构 $ARCH"; exit 1;; esac
VER=$(curl -fsSL https://api.github.com/repos/fatedier/frp/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
[ -n "$VER" ] || { echo "取不到 frp 最新版本号"; exit 1; }
TMP=$(mktemp -d)
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${VER}/frp_${VER}_linux_${A}.tar.gz" -o "$TMP/frp.tgz"
tar xzf "$TMP/frp.tgz" -C "$TMP"
install -m 755 "$TMP/frp_${VER}_linux_${A}/frps" /usr/local/bin/frps
rm -rf "$TMP"
echo "frps $(/usr/local/bin/frps -v)"

echo "== 3/6 frps 配置"
mkdir -p /etc/frp /var/log/frp
if [ -f /etc/frp/frps.toml ] && grep -q '^auth.token' /etc/frp/frps.toml; then
  TOKEN=$(sed -nE 's/^auth.token *= *"([^"]+)".*/\1/p' /etc/frp/frps.toml)
else
  TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi
cat > /etc/frp/frps.toml <<EOF
bindAddr = "0.0.0.0"
bindPort = 7000
# UDP 传输：跨境丢包重时客户端可改 transport.protocol = "kcp" 或 "quic"
kcpBindPort = 7000
quicBindPort = 7002
auth.method = "token"
auth.token = "${TOKEN}"
allowPorts = [{ start = 10000, end = 10100 }]
transport.maxPoolCount = 5
transport.tcpKeepalive = 60
log.to = "/var/log/frp/frps.log"
log.level = "info"
log.maxDays = 3
EOF
chmod 600 /etc/frp/frps.toml

echo "== 4/6 systemd"
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frps relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1
systemctl restart frps
sleep 2
systemctl is-active --quiet frps || { journalctl -u frps -n 30 --no-pager; exit 1; }

echo "== 5/6 防火墙"
ufw allow 22/tcp >/dev/null
ufw allow 7000/tcp >/dev/null
ufw allow 7000/udp >/dev/null
ufw allow 7002/udp >/dev/null
ufw allow 10000:10100/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,20p'

echo "== 6/6 自检"
ss -lntup | grep -E 'frps' || true
echo -n "下载测速（Cloudflare 50MB）："
curl -s -o /dev/null -w '%{speed_download}\n' --max-time 30 'https://speed.cloudflare.com/__down?bytes=50000000' | awk '{printf "%.1f Mbit/s\n", $1*8/1000000}'
echo -n "上传测速（Cloudflare 20MB）："
head -c 20000000 /dev/zero | curl -s -o /dev/null -w '%{speed_upload}\n' --max-time 30 --data-binary @- 'https://speed.cloudflare.com/__up' | awk '{printf "%.1f Mbit/s\n", $1*8/1000000}'

cat <<EOF

========================================
frps 已就绪。公网 IP：$(curl -s --max-time 5 https://api.ipify.org || echo 本机IP)
frpc 要用的令牌（别发到公开地方）：
  ${TOKEN}
========================================
EOF
