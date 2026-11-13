#!/usr/bin/env bash
# 在国内中转服务器（广州 81.71.94.90，Ubuntu）上构建最新版并通过 8099 端口长期提供下载，
# 给连不上 GitHub/npm 的电脑覆盖更新。以后要更新，只需在服务器上重跑同一条命令。
# 仓库已转私有，服务器用只读令牌（Contents: Read-only）直连 api.github.com 下载代码。
# 首次（把令牌存到 ~/.config/phone-cloud/github-token，并把本脚本装到 ~/pr-update/serve-update.sh）：
#   ssh ubuntu@81.71.94.90 'T=<令牌>; curl -fsSL -u x:$T -H Accept:application/vnd.github.raw https://api.github.com/repos/tst609370-create/phone-cloud-platform/contents/tools/serve-update.sh -o /tmp/su.sh && GH_TOKEN=$T bash /tmp/su.sh'
# 以后更新：ssh ubuntu@81.71.94.90 "bash ~/pr-update/serve-update.sh"
# 可选：bash ~/pr-update/serve-update.sh <分支或提交号>；PORT=8099 改端口（别用 7000/7002/10000-10100）
# 服务器连不上 GitHub 时：把源码 zip 传到服务器，SRC_ZIP=/路径/src.zip bash ~/pr-update/serve-update.sh
set -euo pipefail
REF="${1:-main}"
PORT="${PORT:-8099}"
REPO="tst609370-create/phone-cloud-platform"
BASE="$HOME/pr-update"
WWW="$BASE/www"
NODE_VER="v24.11.0"
mkdir -p "$BASE" "$WWW"
cd "$BASE"
red() { echo -e "\033[31m$*\033[0m" >&2; }
trap 'red "失败：第 $LINENO 行出错，上面是原因。修好后重跑同一条命令即可。"' ERR

fetch() { # fetch <github 地址（不带 https://）> <输出文件>
  local path="$1" out="$2" u
  for u in "https://ghfast.top/https://$path" "https://gh-proxy.com/https://$path" "https://$path"; do
    echo "下载 $u"
    if curl -fL --connect-timeout 15 --max-time 900 -o "$out.tmp" "$u" && [ -s "$out.tmp" ]; then mv "$out.tmp" "$out"; return 0; fi
  done
  red "所有下载源都失败：$path"
  return 1
}

echo "== 1/5 准备 Node 24（npmmirror）"
NODE_DIR="$BASE/node-$NODE_VER"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fL --connect-timeout 15 -o node.tar.xz "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR" && tar -xJf node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f node.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
node -v

echo "== 2/5 下载代码（$REF）"
TOKEN_FILE="$HOME/.config/phone-cloud/github-token"
if [ -n "${GH_TOKEN:-}" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")" && chmod 700 "$(dirname "$TOKEN_FILE")"
  ( umask 077; printf '%s' "$GH_TOKEN" > "$TOKEN_FILE" )
  echo "令牌已保存到 $TOKEN_FILE（仅本用户可读）"
fi
TOKEN=""; [ -s "$TOKEN_FILE" ] && TOKEN=$(cat "$TOKEN_FILE")
COMMIT=""
if [ -n "${SRC_ZIP:-}" ]; then
  cp "$SRC_ZIP" src.zip
elif [ -n "$TOKEN" ]; then
  # 私有仓库：直连 GitHub API（令牌不经过 ghfast 等第三方代理）
  COMMIT=$(curl -fsS --connect-timeout 15 --retry 3 -u "x:$TOKEN" -H "Accept: application/vnd.github.sha" \
    "https://api.github.com/repos/$REPO/commits/$REF" || true)
  ok=""
  for i in 1 2 3; do
    echo "下载 api.github.com/repos/$REPO/zipball/$REF（第 $i 次）"
    if curl -fL --connect-timeout 15 --max-time 900 -u "x:$TOKEN" -o src.zip.tmp "https://api.github.com/repos/$REPO/zipball/$REF" && [ -s src.zip.tmp ]; then
      mv src.zip.tmp src.zip; ok=1; break
    fi
    sleep 5
  done
  [ -n "$ok" ] || { red "从 GitHub 下载失败：令牌无效/过期（重新跑首次命令换令牌），或服务器连不上 api.github.com（改用 SRC_ZIP）"; exit 1; }
else
  # 没有令牌：仅公开仓库可用
  if [ "$REF" = main ]; then ARCHIVE="github.com/$REPO/archive/refs/heads/main.zip"; else ARCHIVE="github.com/$REPO/archive/$REF.zip"; fi
  fetch "$ARCHIVE" src.zip || { red "仓库是私有的，需要令牌：按脚本开头注释跑首次命令"; exit 1; }
fi
[ -n "$COMMIT" ] || COMMIT=$(python3 -c 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).comment.decode().strip())' src.zip || true)
echo "版本：${COMMIT:-未知}"
rm -rf src && mkdir src && python3 -m zipfile -e src.zip src
APP=$(ls -d src/*/web-phone-remote | head -n 1)

echo "== 3/5 构建（npm ci + webpack，约 3–6 分钟）"
( cd "$APP" && npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com \
  && npx webpack --config webpack/ws-scrcpy-web.prod.ts )
for f in index.js public/tianxi.css public/login-assets/globe.js; do
  [ -e "$APP/dist/$f" ] || { red "构建结果缺少 $f"; exit 1; }
done

echo "== 4/5 打包"
rm -f "$WWW/dist.zip.tmp"
( cd "$APP" && python3 -c 'import os,sys,zipfile
z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)
for r,_,fs in os.walk("dist"):
    for f in fs: z.write(os.path.join(r,f))
z.close()' "$WWW/dist.zip.tmp" )
mv "$WWW/dist.zip.tmp" "$WWW/dist.zip"
TOOLS="$(dirname "$APP")/tools"
cp "$TOOLS/update-local-windows.ps1" "$WWW/update.bin"
# 其他一键脚本也放到 8099/tools/ 下（不含令牌），仓库私有后从这里取
rm -rf "$WWW/tools" && mkdir -p "$WWW/tools" && cp "$TOOLS"/*.sh "$TOOLS"/*.ps1 "$WWW/tools/" 2>/dev/null || true
# 自更新：下次直接 bash ~/pr-update/serve-update.sh（先写临时文件再 mv，不影响正在运行的这份）
cp "$TOOLS/serve-update.sh" "$BASE/serve-update.sh.new" && mv "$BASE/serve-update.sh.new" "$BASE/serve-update.sh"
echo "${COMMIT:-unknown}" > "$WWW/version.txt"
rm -rf src src.zip

echo "== 5/5 下载服务（systemd: pr-update-http，端口 $PORT，开机自启）"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
$SUDO tee /etc/systemd/system/pr-update-http.service >/dev/null <<EOF
[Unit]
Description=Phone remote update package (http :$PORT)
After=network-online.target
[Service]
User=$(id -un)
ExecStart=/usr/bin/python3 -m http.server $PORT --directory $WWW
Restart=always
[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable pr-update-http >/dev/null 2>&1
$SUDO systemctl restart pr-update-http
command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q active && $SUDO ufw allow "$PORT/tcp" >/dev/null || true
sleep 1
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/version.txt" || { red "下载服务没起来：sudo journalctl -u pr-update-http -n 30"; exit 1; }

IP=$(curl -fsS --max-time 5 https://myip.ipip.net/s 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
IP=$(echo "$IP" | tr -d '[:space:]')
echo
echo -e "\033[32m已就绪：版本 ${COMMIT:0:7}，http://$IP:$PORT/dist.zip\033[0m"
echo "以后更新服务器上的包：ssh $(id -un)@$IP \"bash ~/pr-update/serve-update.sh\""
echo "电脑（国内、迪拜都一样）用 PowerShell 执行："
echo "\$env:PR_SRC='http://$IP:$PORT'; iex ([Text.Encoding]::UTF8.GetString((iwr \"\$env:PR_SRC/update.bin\" -UseBasicParsing).Content))"
