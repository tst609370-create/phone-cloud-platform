#!/usr/bin/env bash
# Set up the frps public relay on a fresh Ubuntu 22.04/24.04 server (run as root):
#   curl -fsSL https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/setup-relay-server.sh | bash
#
# 1. BBR + fq and larger TCP buffers (much steadier than cubic on lossy cross-border links).
# 2. Latest frps (GitHub, falls back to a pinned version and mirrors), systemd auto start/restart.
# 3. frps listens on TCP 7000, KCP (UDP 7000) and QUIC (UDP 7002).
# 4. Random token on first run in /etc/frp/frps.toml (mode 600); reruns keep it.
# 5. ufw allows only 22, 7000, 7002, 10000-10100.
# 6. Prints the token, listeners and a speed test.
# Output is English on purpose: web VNC consoles often cannot show Chinese.
# Every network step has a timeout, so nothing waits forever.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say() { echo; echo "== $*"; }
fetch() { curl -fL --connect-timeout 10 --max-time 120 --retry 2 -sS "$@"; }

say "1/6 network tuning (BBR)"
cat > /etc/sysctl.d/90-phone-relay.conf <<'SYSCTL'
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
SYSCTL
modprobe tcp_bbr 2>/dev/null || true
# Load only our file: other files in /etc/sysctl.d can print harmless "Invalid argument" lines.
sysctl -p /etc/sysctl.d/90-phone-relay.conf >/dev/null
echo "congestion control: $(sysctl -n net.ipv4.tcp_congestion_control)"

say "2/6 packages + frps download"
need=""
for c in curl tar ufw; do command -v "$c" >/dev/null || need="$need $c"; done
if [ -n "$need" ]; then
  echo "installing:$need (apt, up to ~3 min)"
  timeout 180 apt-get -o DPkg::Lock::Timeout=60 update -q || echo "apt update slow/failed, trying install anyway"
  timeout 300 apt-get -o DPkg::Lock::Timeout=60 install -y -q $need
else
  echo "curl/tar/ufw already present, skipping apt"
fi
ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) A=amd64;; arm64) A=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
FALLBACK_VER=0.65.0
VER=$(fetch https://api.github.com/repos/fatedier/frp/releases/latest 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/' || true)
[ -n "$VER" ] || { VER=$FALLBACK_VER; echo "GitHub API unreachable, using frp v$VER"; }
TMP=$(mktemp -d)
NAME="frp_${VER}_linux_${A}"
ok=""
for base in \
  "https://github.com/fatedier/frp/releases/download" \
  "https://ghfast.top/https://github.com/fatedier/frp/releases/download" \
  "https://gh-proxy.com/https://github.com/fatedier/frp/releases/download"; do
  echo "downloading frp v$VER from ${base%%/https:*} ..."
  if curl -fL --connect-timeout 10 --max-time 120 --progress-bar "$base/v${VER}/${NAME}.tar.gz" -o "$TMP/frp.tgz" && tar xzf "$TMP/frp.tgz" -C "$TMP"; then ok=1; break; fi
  echo "  failed, trying next source"
done
[ -n "$ok" ] || { echo "could not download frp from any source"; exit 1; }
install -m 755 "$TMP/$NAME/frps" /usr/local/bin/frps
rm -rf "$TMP"
echo "frps $(/usr/local/bin/frps -v)"

say "3/6 frps config"
mkdir -p /etc/frp /var/log/frp
TOKEN=""
if [ -f /etc/frp/frps.toml ]; then
  TOKEN=$(sed -nE 's/^auth.token *= *"([^"]+)".*/\1/p' /etc/frp/frps.toml)
fi
[ -n "$TOKEN" ] || TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat > /etc/frp/frps.toml <<FRPS
bindAddr = "0.0.0.0"
bindPort = 7000
# UDP transports for lossy cross-border links: client transport.protocol = "kcp" or "quic"
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
FRPS
chmod 600 /etc/frp/frps.toml

say "4/6 systemd service"
cat > /etc/systemd/system/frps.service <<'UNIT'
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
UNIT
systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1
systemctl restart frps
sleep 2
systemctl is-active --quiet frps || { journalctl -u frps -n 30 --no-pager; exit 1; }

say "5/6 firewall"
ufw allow 22/tcp >/dev/null
ufw allow 7000/tcp >/dev/null
ufw allow 7000/udp >/dev/null
ufw allow 7002/udp >/dev/null
ufw allow 10000:10100/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,20p'

say "6/6 self-check"
ss -lntup | grep -E 'frps' || true
echo -n "download speed (Cloudflare 50MB): "
curl -s -o /dev/null -w '%{speed_download}\n' --connect-timeout 10 --max-time 30 'https://speed.cloudflare.com/__down?bytes=50000000' | awk '{printf "%.1f Mbit/s\n", $1*8/1000000}' || echo failed
echo -n "upload speed (Cloudflare 20MB): "
head -c 20000000 /dev/zero | curl -s -o /dev/null -w '%{speed_upload}\n' --connect-timeout 10 --max-time 30 --data-binary @- 'https://speed.cloudflare.com/__up' | awk '{printf "%.1f Mbit/s\n", $1*8/1000000}' || echo failed

cat <<DONE

========================================
frps is running. Public IP: $(curl -s --max-time 5 https://api.ipify.org || echo unknown)
frpc token (keep private, do not post it):
  ${TOKEN}
========================================
DONE
