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
| `tools/update-local-windows.ps1` | 把 Windows 本机已装的手机远控（%LOCALAPPDATA%\PhoneRemote）更新到 main：下载源码 → 构建 → 备份并替换 app\dist → 重启任务 PhoneRemote-Node → 桌面/开始菜单控制台快捷方式换成 Chrome/Edge `--app` 独立窗口（优先 Chrome） | PowerShell |
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
| `src/app/` | 前端（webpack 打包）：`mic/` 麦克风按钮、`audio/` 播放声、`player/` 解码、`googDevice/` 控制工具栏 |
| `public/` | 静态页：`admin.html` 租用后台、`index.html`/`phones.js`/`phones.css` 手机墙、`snapshot.*` 快照模式；`tianxi.css`/`tianxi.js` 是 Tianxi UI 的静态移植（令牌 + Select/Tooltip/Toast/确认框），所有页面共用 |
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
- scrcpy 版本/参数 → `src/server/ScrcpyOptions.ts`、`scrcpyServerVersion.ts`
- 安装包、中转服务器地址 → `installer/windows/logic.go`（`relayHost`）
- 桌面快捷方式 → `logic.go`（`shortcutFiles`、`appWindowShortcuts`、`findAppBrowser`），写入在 `install_windows.go`（`writeAppWindowShortcuts`）
- 邀请/注册 → `installer/bootstrap/enroll.mjs`、`server.mjs`
- SOCKS5/FRP → `phone_socks_manager.py`（`Gateway`、`FrpProcess`、`SshTunnel`、`App`）
