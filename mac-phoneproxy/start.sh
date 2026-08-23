#!/bin/sh
set -eu

IFS=/ read -r socks_host socks_port socks_user socks_pass extra
[ -n "$socks_host" ] && [ -n "$socks_port" ] && [ -n "$socks_user" ] && [ -n "$socks_pass" ] && [ -z "${extra:-}" ] || {
  echo "SOCKS5 格式应为：主机/端口/用户名/密码" >&2
  exit 2
}
case "$socks_port" in *[!0-9]*|'') echo "SOCKS5 端口无效" >&2; exit 2;; esac

exit_ip=$(/usr/bin/curl -fsS --max-time 15 --socks5-hostname "$socks_host:$socks_port" \
  --proxy-user "$socks_user:$socks_pass" https://api.ipify.org)

yaml_quote() { /usr/bin/printf '%s' "$1" | /usr/bin/sed "s/'/''/g"; }
conf=$(/usr/bin/mktemp /tmp/phoneproxy.XXXXXX)
trap '/bin/rm -f "$conf"' EXIT HUP INT TERM
/bin/chmod 600 "$conf"

cat >"$conf" <<EOF
tunnel:
  name: utun999
  mtu: 8500
  multi-queue: false
  ipv4: 198.18.0.1
socks5:
  address: '$(yaml_quote "$socks_host")'
  port: $socks_port
  udp: 'udp'
  username: '$(yaml_quote "$socks_user")'
  password: '$(yaml_quote "$socks_pass")'
misc:
  log-file: stderr
  log-level: warn
  task-stack-size: 24576
  tcp-buffer-size: 16384
  connect-timeout: 10000
  tcp-read-write-timeout: 600000
  udp-read-write-timeout: 600000
EOF

/usr/bin/pkill -TERM -f '/usr/local/sbin/hev-socks5-tunnel' 2>/dev/null || true
/bin/sleep 1
/usr/bin/nohup /usr/local/sbin/hev-socks5-tunnel "$conf" \
  >/var/log/phoneproxy-hev.log 2>&1 &
pid=$!
/bin/sleep 2
/bin/kill -0 "$pid"
/sbin/ifconfig utun999 >/dev/null

cat >/etc/pf.anchors/phoneproxy <<'EOF'
pass quick on lo0 all
pass in quick on en0 inet from 192.168.50.0/24 to 192.168.50.0/24 keep state
pass in quick on en0 route-to utun999 inet proto { tcp, udp, icmp } from 192.168.50.0/24 to any keep state
block drop out quick on en1 inet from 192.168.50.0/24 to any
EOF

/usr/sbin/sysctl -w net.inet.ip.forwarding=1 >/dev/null
/usr/sbin/sysctl -w net.inet.tcp.tso=0 >/dev/null
/sbin/pfctl -a com.apple/phoneproxy -f /etc/pf.anchors/phoneproxy
/sbin/pfctl -E >/dev/null 2>&1 || true
/usr/bin/printf '%s\n' "$pid" >/var/run/phoneproxy-hev.pid
/usr/bin/printf '%s\n' "$exit_ip" >/var/run/phoneproxy-exit-ip
