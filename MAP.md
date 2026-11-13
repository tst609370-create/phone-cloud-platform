# MAP — phone-cloud-platform

手机/云手机相关工具合集。三块彼此独立：**手机 4G/5G 出口转 SOCKS5**、**浏览器远程控制安卓（基于 ws-scrcpy-web，含租用/麦克风注入）**、零散辅助工具。

## 目录

| 路径 | 职责 | 语言 |
| --- | --- | --- |
| `phone_socks_manager.py` | Windows GUI（tkinter）：ADB 选手机 → 装 DataProxy → 本机 SOCKS5 网关（带账号密码）→ 可选 FRP 公网映射（经 SSH 隧道取 Token）→ 出口 IP/风险检测 | Python |
| `test_phone_socks_manager.py` | 上面的单测（需要 tkinter） | Python |
| `启动手机SK5.cmd` | Windows 双击启动 `pythonw phone_socks_manager.py` | cmd |
| `mac-phoneproxy/` | macOS 版手机代理管理（`manager.rb` 逻辑、`ui.rb` 界面、AppleScript 启动/授权/升级） | Ruby |
| `tools/xiaomi-router-proxy.mjs` | 小米路由器代理辅助脚本 | Node |
| `tools/update-local-windows.ps1` | 把 Windows 本机已装的手机远控（%LOCALAPPDATA%\PhoneRemote）更新到 main：仓库私有后默认从广州服务器 8099 下载已构建 dist（`$env:PR_SRC='github'`+`GH_TOKEN` 才本机构建） → 备份并替换 app\dist → 重启任务 PhoneRemote-Node → 桌面/开始菜单控制台快捷方式换成 Chrome/Edge `--app` 独立窗口（优先 Chrome） | PowerShell |
| `tools/find-wechat-backup.ps1` | 在 app\dist.bak-* 备份里找含微信相关代码（本机加过、仓库里没有）的旧版本，打包到桌面 zip 并默认换回运行；`$env:NO_RESTORE='1'` 只查不换 | PowerShell |
| `tools/setup-https-ip.sh` | 中转服务器公网 IP 挂 HTTPS（Caddy + Let's Encrypt IP 短期证书自动续期），frp 端口 P → https 端口 P+10000，需 80 可达 | bash |
| `tools/setup-chatwoot.sh` | 广州服务器一键部署 Chatwoot 在线客服（Docker：rails+sidekiq+pgvector+redis，/opt/chatwoot，http :3000；有 caddy-ip 时 https :8443 写 /etc/caddy/conf.d/chatwoot.caddy）；重跑即升级 | bash |
| `tools/serve-update.sh` | 所有电脑的更新源：服务器用只读令牌（~/.config/phone-cloud/github-token）直连 api.github.com 拉私有仓库、构建、开 8099 下载（dist.zip、update.bin、tools/*）；自装到 ~/pr-update/serve-update.sh，以后 `bash ~/pr-update/serve-update.sh` | bash |
| `tools/setup-relay-server.sh` | 新服务器一键装 frps 公网中转（root 执行）：BBR、frps TCP/KCP/QUIC、systemd、ufw、随机令牌、测速 | bash |
| `tools/switch-relay-windows.ps1` | 把本机 frpc 切到新 frps（交互输入令牌，先 QUIC 后 TCP，失败自动恢复旧配置） | PowerShell |
| `tools/deskflow/` | Deskflow 键鼠共享配置（Win 服务端 / Mac 客户端） | conf |
| `web-phone-remote/` | **主体**。上游 [ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web)（GPL-3.0）+ 本仓库定制：租用/登录鉴权、APK 库、快照墙、虚拟麦克风、Windows 一键安装包、邀请注册服务 | TS/Rust/Go/Java |

## web-phone-remote 内部

| 路径 | 职责 |
| --- | --- |
| `src/server/index.ts` | 服务端入口（HTTP + WebSocket，ADB 设备跟踪、scrcpy 推流） |
| `src/server/api/` | REST：`AuthApi` 登录、`UsersApi` 用户、`RentalsApi` 租用（识别码/有效期，含外网入口常量）、`ApkLibraryApi`、`DeviceDiscoveryApi`、`SettingsApi`、`UpdatesApi` 等 |
| `src/server/auth/` | 鉴权：`AuthGate`（HTTP/WS 门禁）、`deviceAccess`（设备分配给谁）、`rentalExpiry`、`lockdown`、`session`、`loginPolicy` |
| `src/server/db/` | SQLite 存储与迁移（用户、设备、设置） |
| `src/server/mic/` + `MicInject.ts` | 电脑麦克风 → 手机麦克风：`route` WS 路由（action=`mic`）、`hub`/`session` 会话、`deviceBridge` 选 LSPosed 或 shell 通道 |
| `src/server/ScrcpyOptions.ts`, `scrcpyServerVersion.ts`, `ensureScrcpyServerPushed.ts` | scrcpy-server 启动参数与版本 |
| `src/app/` | 前端（webpack 打包）：`mic/` 麦克风按钮、`audio/` 播放声（AudioPlayer；audioHealth.ts 判断无声原因，embed 底部 #audio-note 显示）、`player/` 解码、`googDevice/` 控制工具栏 |
| `public/` | 静态页：`admin.html` 租用后台、`index.html`/`phones.js`/`phones.css` 手机墙、`snapshot.*` 快照模式；`tianxi.css`/`tianxi.js` 是 Tianxi UI 的静态移植（令牌 + Select/Tooltip/Toast/确认框），所有页面共用 |
| `android/root-audio/` + `src/server/rootAudio.ts` | 安卓 8–10 已 ROOT 手机的播放声：`su` 下跑 `RootAudioMain` 录 REMOTE_SUBMIX，按 scrcpy 音频流格式（codec id + 包）编 AAC/raw 经 `adb reverse localabstract:wsaudio_<scid>` 送回，替换 scrcpy 的音频 socket。`build.sh` 用 stubs/ 编译 + Maven Central 的 dalvik-dx 转 dex，产物 `prebuilt/root-audio.jar`（webpack 拷进 dist） |
| `android/virtual-mic/` | 手机侧虚拟麦克风：LSPosed 模块、Magisk 包装、shell 注入 jar |
| `installer/windows/` | Go 写的单文件 Windows 安装器（UAC、开机任务、向注册服务换配置） |
| `installer/bootstrap/` | 服务器侧邀请/注册服务（`enroll`、`assignPort`、`server.mjs`，配 frps 插件与 Caddy） |
| `launcher/`, `tray/`, `common/` | 上游 Rust 启动器/托盘/公共库 |
| `macos/` | macOS 部署：`PhoneCloudManager.swift`、launchd plist、cloudflared 隧道模板 |
| `docs/虚拟麦克风.md` | 麦克风功能说明与选路规则 |

## 构建 / 运行 / 测试

```bash
# SOCKS5 管理器（Windows，需要带 tkinter 的 Python）
python -m unittest -v

# web-phone-remote（需要 Node >= 24，Node 22 会因 node-pty ABI 不匹配挂掉）
cd web-phone-remote
npm ci && npm test            # vitest，全部 src/** 测试
npm run build                 # webpack → dist/
npm start                     # 构建 + 开发监管进程
node --test installer/setup-auth.test.mjs installer/bootstrap/*.test.mjs   # 安装/注册服务（node:test）
(cd installer/windows && go test ./...)                                     # Go 安装器
```

注意：`web-phone-remote/.github/workflows/` 在子目录，GitHub 不会执行，本仓库实际没有 CI。

## 常见改动去哪改

- 界面风格（Tianxi UI，暗色）→ 令牌和通用控件改 `public/tianxi.css`、`public/tianxi.js`；页面布局改 `public/phones.css`、`admin.html` 内联样式；登录页（双栏 + 地球，照 tianxi-ui `#/login`）在 `src/server/auth/AuthGate.ts` 的 `authPage()`；地球脚本 `public/login-assets/globe.js` 由 `globe.src.js` 用 esbuild 打包 cobe@2.0.1 生成（`npx esbuild globe.src.js --bundle --minify --format=iife`），走免登录白名单 `/login-assets/`；内嵌画面工具栏色在 `src/style/ws-scrcpy.css`。下拉一律 `<select data-tx-select>`，提示用 `TX.toast`/`TX.confirm`，不用 alert/confirm
- 租用识别码、有效期、外网域名 → `src/server/api/RentalsApi.ts`、`public/admin.html`、`src/server/auth/rentalExpiry.ts`
- 谁能看/控哪台手机 → `src/server/auth/deviceAccess.ts`、`AuthGate.ts`
- 麦克风 → 服务端 `src/server/mic/`、前端 `src/app/mic/`、手机侧 `android/virtual-mic/`
- 安卓 11 以下没声音 / ROOT 采集 → `src/server/rootAudio.ts`（`hasRoot` 用 `su -c id`，接入点 `ScrcpyConnection.start`），手机端 `android/root-audio/`（改完跑 `sh android/root-audio/build.sh` 重出 jar）
- scrcpy 版本/参数 → `src/server/ScrcpyOptions.ts`、`scrcpyServerVersion.ts`
- 「自动」画质黑屏自动降档 → `public/phones.js` 的 `autoLimit`/`autoCap`/`onVideoHealth`（先 1080，确认出画 `phone-auto-ok:<serial>` 后才升一档，黑屏封顶 `phone-auto-cap:<serial>`；侧栏显示前端版本 `UI_VERSION`），播放器 `WebCodecsPlayer.checkBlack`/`reportHealth` 发 `phone-video-health` 事件
- 手机分辨率上限（全员生效）→ `src/server/videoSizeCap.ts`（LE21xx 默认 1080；浏览器报黑屏 POST `/api/settings/video-cap` 存 app_settings `videoCap:<serial>`），`ScrcpyConnection.buildOptions` 里夹紧 max_size
- 视频尺寸对齐 → `src/server/ScrcpyOptions.ts` 默认 `min_size_alignment=16`（scrcpy 4.x 默认按编码器报的 2px 对齐，一加 ColorOS 出 486 宽黑帧）
- http://公网IP（非安全上下文）没有 WebCodecs → `src/app/player/mseDecoder.ts` + `fmp4.ts` 用 MSE 回退（仅 H.264）；画面卡住要关键帧 → `WebCodecsPlayer.armStallTimer` + `onNeedKeyframe`（RESET_VIDEO）
- 画面黑屏/解码失败自愈 → `web-phone-remote/src/app/player/WebCodecsPlayer.ts`（`recoverDecoder`、`armOutputWatchdog`：出错或 3 秒无输出改软件解码，记在 localStorage `webcodecs-prefer-software`）
- 网速跟不上时的丢帧/追帧 → `src/server/videoBackpressure.ts`（`ackedThresholds` 按码率定阈值，`StreamNetMeter` 统计在途/往返/送达码率），接入点 `ScrcpyConnection.ts` 的 `onVideoFrame`/`onAck`/`startStats`；浏览器每帧回 ACK（`ChannelId.ACK`，`ScrcpyDemuxer.sendAck`），服务器每秒发 `ChannelId.STATS`；WebSocket 心跳 → `services/WebSocketServer.ts` 的 `startHeartbeat`
- 九宫格小窗（只看不操作）→ 点小窗原地放大操作（电脑可同时放大多台，大小跟侧栏小/中/大；手机浏览器铺满一台）：`public/phones.js` 的 `expand`/`collapseCard`/`collapseExpanded`/`sizeExpanded`、小窗挡板 `.preview-shield`（`createCard` 里）、小窗尺寸 `gridFit`/`refitCards`、小窗低码率 `videoProfile`（`PREVIEW_BITRATE`），操作中不为升画质重连 `userBusy`；样式在 `phones.css` 的「九宫格小窗」段和 700px 以下媒体查询
- 触控手感 → `src/app/interactionHandler/`：拖出画面边缘贴边不断（`buildTouchOnClient` 的 `clampToEdge`）、真手指多点触控各自 pointerId（`buildPointerTouch`、`FeaturedInteractionHandler.fingerId`）、滚轮按幅度每帧合并（`buildScrollEvent`/`flushScroll`，`WHEEL_PX_PER_UNIT`）
- 手机窗口下方的「延迟/帧/码率」显示和按实测带宽自动降码率 → `public/phones.js` 的 `onNetStats`（事件 `phone-net-stats` 由 `StreamClientScrcpy.onNetStats` 发出），颜色在 `phones.css` 的 `[data-net]`
- frpc 配置与守护脚本 → `installer/windows/logic.go`（`renderFrpcToml`、`frpcRunScript`）；已装机器由 `tools/update-local-windows.ps1` 补丁
- 安装包、中转服务器地址 → `installer/windows/logic.go`（`relayHost`）
- 桌面快捷方式 → `logic.go`（`shortcutFiles`、`appWindowShortcuts`、`findAppBrowser`），写入在 `install_windows.go`（`writeAppWindowShortcuts`）
- 邀请/注册 → `installer/bootstrap/enroll.mjs`、`server.mjs`
- SOCKS5/FRP → `phone_socks_manager.py`（`Gateway`、`FrpProcess`、`SshTunnel`、`App`）
