# 虚拟麦克风（LSPosed / Magisk）

这个目录是手机侧的桥，不是 Node 服务。电脑上的 ws-scrcpy-web 采集麦克风后，有两条进手机的路，都由服务端按探测结果自动选：

1. **LSPosed 模块（root）**  
   在微信进程里钩住 `android.media.AudioRecord.read`。模块连 `127.0.0.1:28256`，这是 `adb reverse` 指回电脑上的桥。注入没开时钩子什么都不做，微信继续用手机麦克风。不钩 `REMOTE_SUBMIX`，避免弄坏投屏的手机声音。
2. **shell 注入（实验，不需要 root）**  
   `shell/` 里的 Java 用反射注册 AudioPolicy loopback，听 `127.0.0.1:28257`。网页只有在这台手机打印 `SHELL_MIC_OK` 后才把按钮标成可用。Android 13 及以上只说明值得去试，不是成功保证。零售机上 shell 经常没有 `MODIFY_AUDIO_ROUTING`，那时进程打印 `SHELL_MIC_NO:...`，按钮保持灰色。

用法、按钮手势和支持范围见 [docs/虚拟麦克风.md](../../docs/虚拟麦克风.md)。

## 编译 shell 注入包

在 `web-phone-remote` 目录：

```bash
sh android/virtual-mic/build-shell-jar.sh
```

产物：`android/virtual-mic/prebuilt/virtual-mic.jar`。  
`app_process` 读的是 jar 里的 `classes.dex`。网页服务启动注入时会把它推到手机的 `/data/local/tmp/ws-virtual-mic.jar`。需要 JDK，第一次还要从 Google Maven 下载 d8（r8）。

手动看探测输出（手机会短暂注册再卸掉音频策略）：

```bash
adb push android/virtual-mic/prebuilt/virtual-mic.jar /data/local/tmp/ws-virtual-mic.jar
adb shell CLASSPATH=/data/local/tmp/ws-virtual-mic.jar app_process / com.wsphone.shellmic.ShellMicMain probe
```

成功是一行 `SHELL_MIC_OK`。失败是 `SHELL_MIC_NO:` 加原因。

## 编译并安装 LSPosed 模块

需要 Android SDK（compileSdk 34）和 Gradle 8。

```bash
cd android/virtual-mic/lsposed-module
gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

然后在 LSPosed 管理器里：

1. 启用「虚拟麦克风」。
2. 作用域勾选微信 `com.tencent.mm`。只给微信注入时不要勾系统框架。
3. 强行停止微信或重启手机，让钩子进新进程。
4. 再打开电脑上的投屏，用工具栏麦克风。

模块没有桌面图标，包名是 `com.wsphone.virtualmic`。服务端用 `pm path com.wsphone.virtualmic` 判断装没装。装了但没在 LSPosed 启用时，按钮仍可用，微信却听不到电脑麦；启用并重开微信即可。

默认建议作用域只有微信。要对别的录音应用生效，在 LSPosed 里把那个包名加进作用域。

## Magisk 模块（可选）

`magisk/` 不是另一套注入实现。LSPosed 本身就跑在 Magisk / KernelSU 上。这个目录只是方便把 APK 打进一个 Magisk 模块：

1. 先按上面的命令编出 `app-debug.apk`。
2. 复制为 `magisk/virtual-mic.apk`（不要提交这个 apk，本仓库不带它）。
3. 把 `magisk/` 打成 zip（根目录就是 `module.prop`、`customize.sh`、`service.sh`、apk）。
4. 在 Magisk 里刷入。`customize.sh` 会 `pm install -r`。刷完仍然要在 LSPosed 里启用并勾选微信。

`service.sh` 只在 `/data/local/tmp/wsphone_virtualmic.magisk` 写一行标记，不另起守护进程。音频不经过 Magisk，而经过 adb reverse。

## 帧格式

和 `src/common/micProtocol.ts` 一致：

| 类型 | 值 | 方向 | 载荷 |
| --- | --- | --- | --- |
| HELLO | 1 | 双方 | ASCII `INJECT` 或 `CONSUME` |
| FORMAT | 2 | 电脑 → 手机 | u32le 采样率, u16le 声道, u16le 位深 |
| PCM | 3 | 电脑 → shell | s16le 单声道 |
| STOP / START | 4 / 5 | 电脑 → shell | 空 |
| READ | 16 | 钩子 → 电脑 | u32le 采样率, u16le 声道, u16le 编码, u32le 字节数 |
| DATA | 17 | 电脑 → 钩子 | 请求的 PCM |
| INACTIVE | 18 | 电脑 → 钩子 | 空，钩子改走真实麦克风 |

长度是大端 u32，放在类型字节后面。端口：钩子 28256，shell 28257，都只绑在手机的 127.0.0.1。
