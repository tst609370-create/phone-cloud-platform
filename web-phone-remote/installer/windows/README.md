# Windows 单文件安装器

双击 `PhoneRemoteSetup.exe`。它会先用中文说明要安装手机远控、并在登录 Windows 后自动启动，然后弹出系统的管理员确认。安装器自己带好 Node、adb、frpc 和已经编译好的远控程序，不会在对方电脑上执行 `npm install` 或 `npm run build`。

不要从压缩包预览里直接运行 cmd。旧的 `install.cmd` 用当前目录去找 `install.ps1`，用 360 压缩打开时工作目录不对，脚本就找不到。这个 exe 不依赖旁边的脚本。

## 安装器会做的事

- 文件放到 `%LOCALAPPDATA%\PhoneRemote`
- 服务环境变量 `WS_SCRCPY_BIND_HOST=127.0.0.1`，只监听本机
- 生成随机管理员密码，打开强制登录
- 密码只在结束对话框和本机 `credentials.txt` 里。安装日志会把密码打成 `[已隐藏]`
- 注册计划任务 `PhoneRemote-Node`（登录后启动）
- 已安装时可以选择卸载

## 公网中转

安装器没有内置 FRP 令牌。它会自动请求 `https://103.205.240.23:7443/v1/register`，用户不用填写，也不用放 `bootstrap.url`。注册服务还没按契约部署、或证书不受信任时，公网就是未连通，本机安装仍然完成。

契约和要在服务器上做的步骤：`installer/bootstrap/服务端步骤.md`。远端端口在 `10000-10100` 里按设备分配，不写死 `10002`。

## 麦克风

- 插着手机的电脑打开 `http://127.0.0.1:端口` 才是安全上下文，麦克风才可能用。
- 公网 IP 的明文 HTTP 不能开麦。安装包没有受信任的公网证书，远程页面上的麦克风按钮会保持灰色并说明原因。
- 非 root 注入只有手机实际返回 `SHELL_MIC_OK` 才显示可用。
- `phone\virtual-mic.apk` 需要你在手机上自己安装，并在 LSPosed 里手动勾选微信。安装器不会自动 root，也不会静默给 root。

## 签名

构建时没有代码签名证书。exe 未签名。不要指望这份说明教你关掉 SmartScreen。

## 重新构建

在有网络的构建机上：

```bash
sh installer/windows/build-exe.sh
```

产物复制到 `/opt/cursor/artifacts/PhoneRemoteSetup.exe`。对方电脑不需要 Go、Node 源码或 Android SDK。
