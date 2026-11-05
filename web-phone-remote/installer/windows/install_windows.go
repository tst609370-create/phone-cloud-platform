//go:build windows

package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type installerLog struct {
	file    *os.File
	secrets []string
}

func (l *installerLog) hide(secret string) {
	if secret != "" {
		l.secrets = append(l.secrets, secret)
	}
}

func (l *installerLog) printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	for _, secret := range l.secrets {
		line = redact(secret, line)
	}
	fmt.Println(line)
	if l.file != nil {
		_, _ = l.file.WriteString(time.Now().Format("15:04:05 ") + line + "\n")
	}
}

func (l *installerLog) close() {
	if l.file != nil {
		_ = l.file.Close()
	}
}

func installRoot() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return "", fmt.Errorf("找不到 LOCALAPPDATA，无法确定安装目录")
	}
	return filepath.Join(base, "PhoneRemote"), nil
}

func runInstall() error {
	root, err := installRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "logs"), 0o755); err != nil {
		return fmt.Errorf("不能创建日志目录：%w", err)
	}
	logFile, err := os.OpenFile(filepath.Join(root, "logs", "install.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("不能写安装日志：%w", err)
	}
	log := &installerLog{file: logFile}
	defer log.close()
	log.printf("开始安装，目录 %s", root)
	log.printf("安装包未签名。不会把管理员密码写入这份日志。")

	return withRetry(log, "释放安装文件", func() error {
		return extractSelf(root, log)
	})
}

func withRetry(log *installerLog, name string, fn func() error) error {
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		log.printf("%s（第 %d 次）", name, attempt)
		err = fn()
		if err == nil {
			return nil
		}
		log.printf("%s失败：%s", name, err.Error())
		if attempt == 3 || !askRetry(name, err) {
			return fmt.Errorf("%s：%w", name, err)
		}
	}
	return err
}

func extractSelf(root string, log *installerLog) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	f, err := os.Open(exe)
	if err != nil {
		return fmt.Errorf("打不开安装器自身：%w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	invite, payloadSize, err := splitInvite(f, info.Size())
	if err != nil {
		return err
	}
	if invite != "" {
		log.hide(invite)
	}
	reader, err := openPayload(f, payloadSize)
	if err != nil {
		return err
	}
	log.printf("先结束本安装目录里的计划任务和进程，不结束其他软件的 adb 或 node")
	stopOurTasks()
	time.Sleep(time.Second)
	stopOwnedProcesses(root)
	genRoot := filepath.Join(root, "generations", time.Now().Format("20060102T150405.000"))
	if err := os.MkdirAll(genRoot, 0o755); err != nil {
		return err
	}
	count := 0
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		dest, err := safeJoin(genRoot, file.Name)
		if err != nil {
			_ = os.RemoveAll(genRoot)
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			_ = os.RemoveAll(genRoot)
			return err
		}
		if err := writeZipFile(file, dest); err != nil {
			_ = os.RemoveAll(genRoot)
			return fmt.Errorf("无法写入 %s。安装器不会覆盖正在使用的文件，也不结束其他目录里的 adb。请关闭已经打开的本安装窗口后重试。原始错误：%w", dest, err)
		}
		count++
		if count%40 == 0 {
			log.printf("已释放 %d 个文件", count)
		}
	}
	log.printf("已释放到新目录 %s，共 %d 个文件", genRoot, count)
	if _, err := os.Stat(filepath.Join(genRoot, "runtime", "node", "node.exe")); err != nil {
		_ = os.RemoveAll(genRoot)
		return fmt.Errorf("安装包里没有 node.exe")
	}
	if _, err := os.Stat(filepath.Join(genRoot, "app", "dist", "index.js")); err != nil {
		_ = os.RemoveAll(genRoot)
		return fmt.Errorf("安装包里没有远控程序")
	}
	return configureAndStart(root, genRoot, log, invite)
}

func writeZipFile(file *zip.File, dest string) error {
	in, err := file.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func configureAndStart(root, genRoot string, log *installerLog, invite string) error {
	state := filepath.Join(root, "state")
	deps := filepath.Join(genRoot, "dependencies")
	logs := filepath.Join(root, "logs")
	for _, dir := range []string{state, deps, logs, filepath.Join(root, "frp")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	localPort, err := pickLocalPort()
	if err != nil {
		return err
	}
	configPath := filepath.Join(state, "config.json")
	config := fmt.Sprintf("{\r\n  \"installMode\": \"user-service\",\r\n  \"webPort\": %d,\r\n  \"firstRunComplete\": true,\r\n  \"allowedHosts\": []\r\n}\r\n", localPort)
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		return err
	}
	deviceID, err := readOrCreateDeviceID(filepath.Join(state, "device-id.txt"))
	if err != nil {
		return err
	}
	nodeCmd := filepath.Join(root, "run-node.cmd")
	nodeExe := filepath.Join(genRoot, "runtime", "node", "node.exe")
	appDir := filepath.Join(genRoot, "app")
	script := fmt.Sprintf("@echo off\r\nsetlocal\r\nset \"WS_SCRCPY_BIND_HOST=127.0.0.1\"\r\nset \"WS_SCRCPY_CONFIG=%s\"\r\nset \"DEPS_PATH=%s\"\r\nset \"PORT=%d\"\r\nset \"WS_SCRCPY_NO_BROWSER=1\"\r\ncd /d \"%s\"\r\n\"%s\" dist\\index.js >> \"%s\" 2>&1\r\n",
		configPath, deps, localPort, appDir, nodeExe, filepath.Join(logs, "node.log"))
	if err := os.WriteFile(nodeCmd, []byte(script), 0o644); err != nil {
		return err
	}
	if err := registerTask("PhoneRemote-Node", nodeCmd); err != nil {
		return err
	}
	log.printf("已注册登录后自动启动。本机端口 %d，只绑定 127.0.0.1。", localPort)

	frpNote := "这是公共安装包，没有一次性邀请，公网未开通。"
	connected := false
	remotePort := 0
	credFile := filepath.Join(state, "device-auth.json")
	saved, hasSaved := loadCredential(credFile)
	switch enrollmentPlan(hasSaved, invite != "") {
	case "reuse":
		log.hide(saved.DeviceSecret)
		log.printf("使用已保存的设备身份，不再兑换邀请。")
		cfgURL, err := configURL(bootstrapURL())
		if err != nil {
			return err
		}
		cfg, err := fetchConfig(cfgURL, saved.DeviceID, saved.DeviceSecret)
		if err != nil {
			return fmt.Errorf("无法用已保存的设备身份取配置，没有重新兑换邀请：%w", err)
		}
		if err := writeFrpc(root, genRoot, logs, saved.DeviceID, saved.DeviceSecret, cfg, localPort); err != nil {
			return err
		}
		connected = true
		remotePort = cfg.RemotePort
		frpNote = fmt.Sprintf("已复用设备身份，远端端口 %d。未写入共享令牌。", remotePort)
	case "redeem":
		log.printf("正在兑付一次性邀请")
		boot, err := enroll(bootstrapURL(), deviceID, invite)
		if err != nil {
			frpNote = "邀请兑付失败，公网中转未连通：" + err.Error()
			log.printf("%s", frpNote)
		} else {
			log.hide(boot.DeviceSecret)
			record := savedCredential{DeviceID: deviceID, DeviceSecret: boot.DeviceSecret, RemotePort: boot.RemotePort, ServerAddr: boot.ServerAddr, ServerPort: boot.ServerPort}
			if err := saveCredential(credFile, record); err != nil {
				return fmt.Errorf("邀请已兑付，但没能保存设备身份。请保留安装日志并联系管理员，不要换一个新邀请重试：%w", err)
			}
			if err := writeFrpc(root, genRoot, logs, deviceID, boot.DeviceSecret, boot, localPort); err != nil {
				return err
			}
			connected = true
			remotePort = boot.RemotePort
			frpNote = fmt.Sprintf("已为本机分配远端端口 %d。未写入共享令牌。", remotePort)
			log.printf("公网配置已写入本机。设备密钥已隐藏。隧道是否连通要等 frps 插件，这里不视为已可用。")
		}
	default:
		_ = os.Remove(filepath.Join(root, "frp", "frpc.toml"))
		_ = runHidden("schtasks", "/Delete", "/TN", "PhoneRemote-Frpc", "/F")
		log.printf("%s", frpNote)
	}
	stepsPath := filepath.Join(root, "服务端步骤.txt")
	_ = os.WriteFile(stepsPath, []byte(serverStepsText()), 0o644)
	_ = os.WriteFile(filepath.Join(state, "frp-status.txt"), []byte(frpNote+"\r\n"), 0o644)

	var password string
	if err := withRetry(log, "启动本机服务并开启登录", func() error {
		got, err := bootAuth(root, appDir, nodeExe, configPath, deps, localPort, log)
		if err != nil {
			return err
		}
		password = got
		return nil
	}); err != nil {
		return err
	}
	// bootAuth stores the admin password in log.secret only after redact is active.
	// The completion dialog is not the log file.
	cred := filepath.Join(root, "credentials.txt")
	text := finishText(localPort, password, cred, connected, remotePort)
	if err := placeShortcuts(root, localPort); err != nil {
		log.printf("创建快捷方式失败：%s", err.Error())
		text += "\r\n\r\n快捷方式没有全部创建：" + err.Error()
	}
	if err := openLocalPage(localPort); err != nil {
		log.printf("打开本机页面失败：%s", err.Error())
		text += "\r\n\r\n没能自动打开本机页面：" + err.Error() + "\r\n请手动打开 " + localPage(localPort)
	}
	infoBox("安装完成", text)
	return nil
}

func bootAuth(root, appDir, node, configPath, deps string, localPort int, log *installerLog) (string, error) {
	stopOurTasks()
	time.Sleep(500 * time.Millisecond)
	stopOwnedProcesses(root)
	cmd := exec.Command(node, "dist\\index.js")
	cmd.Dir = appDir
	hide(cmd)
	cmd.Env = append(os.Environ(),
		"WS_SCRCPY_BIND_HOST=127.0.0.1",
		"WS_SCRCPY_CONFIG="+configPath,
		"DEPS_PATH="+deps,
		"PORT="+fmt.Sprint(localPort),
		"WS_SCRCPY_NO_BROWSER=1",
	)
	out, err := os.Create(filepath.Join(root, "logs", "node-firstboot.log"))
	if err != nil {
		return "", err
	}
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		out.Close()
		return "", fmt.Errorf("无法启动远控服务：%w", err)
	}
	ready := waitPort(localPort, 180*time.Second)
	dbPath := filepath.Join(filepath.Dir(configPath), "wsscrcpy.db")
	deadline := time.Now().Add(60 * time.Second)
	for ready && time.Now().Before(deadline) {
		if st, err := os.Stat(dbPath); err == nil && st.Size() > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	out.Close()
	time.Sleep(time.Second)
	stopOwnedProcesses(root)
	if !ready {
		tail := tailFile(filepath.Join(root, "logs", "node-firstboot.log"), 1200)
		return "", fmt.Errorf("本机服务没有在 %d 端口起来。日志末尾：%s", localPort, tail)
	}
	if _, err := os.Stat(dbPath); err != nil {
		return "", fmt.Errorf("没有生成登录数据库 %s", dbPath)
	}
	password, err := newPassword(20)
	if err != nil {
		return "", err
	}
	log.hide(password)
	auth := exec.Command(node, filepath.Join(filepath.Dir(appDir), "tools", "setup-auth.mjs"))
	hide(auth)
	auth.Env = append(os.Environ(),
		"PHONE_REMOTE_DB="+dbPath,
		"PHONE_REMOTE_ADMIN_USER="+adminUser,
		"PHONE_REMOTE_ADMIN_PASSWORD="+password,
	)
	authOut, err := auth.CombinedOutput()
	logged := redact(password, string(authOut))
	log.printf("登录设置输出：%s", strings.TrimSpace(logged))
	if err != nil {
		return "", fmt.Errorf("开启登录失败：%s", strings.TrimSpace(logged))
	}
	credPath := filepath.Join(root, "credentials.txt")
	if strings.Contains(logged, "KEEP") {
		kept := savedAdminPassword(string(mustRead(credPath)))
		log.hide(kept)
		if kept != "" {
			password = kept
		} else {
			password = "（这台电脑已经设置过管理员密码，这次没有改。请使用当时安装完成窗口里的密码。）"
		}
	} else {
		cred := fmt.Sprintf("PhoneRemote 本机凭证。不要发送给别人，不要放进压缩包。\r\n用户名: %s\r\n密码: %s\r\n本机管理入口: %s\r\n", adminUser, password, localAdminEntry(localPort))
		if err := os.WriteFile(credPath, []byte(cred), 0o600); err != nil {
			return "", err
		}
	}
	if err := runHidden("schtasks", "/Run", "/TN", "PhoneRemote-Node"); err != nil {
		return "", fmt.Errorf("计划任务没有启动服务：%w", err)
	}
	if !waitPort(localPort, 90*time.Second) {
		stopOwnedProcesses(root)
		return "", fmt.Errorf("计划任务启动后 %d 端口仍不可用，请查看 logs\\node.log", localPort)
	}
	_ = runHidden("schtasks", "/Run", "/TN", "PhoneRemote-Frpc")
	return password, nil
}

func pickLocalPort() (int, error) {
	for port := localPortStart; port <= localPortEnd; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		_ = ln.Close()
		return port, nil
	}
	return 0, fmt.Errorf("%d-%d 本机端口都被占用", localPortStart, localPortEnd)
}

func waitPort(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
		time.Sleep(700 * time.Millisecond)
	}
	return false
}

func readOrCreateDeviceID(path string) (string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		id := strings.TrimSpace(string(raw))
		if len(id) == 32 {
			return id, nil
		}
	}
	id, err := newDeviceID()
	if err != nil {
		return "", err
	}
	return id, os.WriteFile(path, []byte(id+"\n"), 0o600)
}

func bootstrapURL() string {
	if v := strings.TrimSpace(os.Getenv("PHONE_REMOTE_BOOTSTRAP_URL")); v != "" {
		return v
	}
	return defaultBootstrapURL()
}

func enroll(url, deviceID, invite string) (Bootstrap, error) {
	body := fmt.Sprintf(`{"deviceId":"%s","invite":"%s"}`, deviceID, invite)
	raw, err := postJSON(url, body)
	if err != nil {
		if strings.Contains(err.Error(), "返回 403") {
			return Bootstrap{}, fmt.Errorf("邀请已经兑付过，不能再次兑换。若这台电脑已保存设备身份，重试会读取 state\\device-auth.json 并走配置接口，不会丢掉原来的身份")
		}
		return Bootstrap{}, fmt.Errorf("联系注册服务失败：%w", err)
	}
	return parseBootstrap(raw)
}

func fetchConfig(url, deviceID, deviceSecret string) (Bootstrap, error) {
	body := fmt.Sprintf(`{"deviceId":"%s","deviceSecret":"%s"}`, deviceID, deviceSecret)
	raw, err := postJSON(url, body)
	if err != nil {
		return Bootstrap{}, fmt.Errorf("联系配置服务失败：%w", err)
	}
	return parseConfig(raw)
}

func postJSON(url, body string) ([]byte, error) {
	client := &httpClientTimeout{timeout: 20 * time.Second}
	return client.post(url, strings.NewReader(body))
}

type savedCredential struct {
	DeviceID     string `json:"deviceId"`
	DeviceSecret string `json:"deviceSecret"`
	RemotePort   int    `json:"remotePort"`
	ServerAddr   string `json:"serverAddr"`
	ServerPort   int    `json:"serverPort"`
}

func loadCredential(path string) (savedCredential, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return savedCredential{}, false
	}
	var saved savedCredential
	if json.Unmarshal(raw, &saved) != nil || len(saved.DeviceID) != 32 || len(saved.DeviceSecret) != 64 {
		return savedCredential{}, false
	}
	return saved, true
}

func saveCredential(path string, saved savedCredential) error {
	raw, err := json.Marshal(saved)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeFrpc(root, genRoot, logs, deviceID, deviceSecret string, boot Bootstrap, localPort int) error {
	boot.DeviceSecret = deviceSecret
	toml, err := renderFrpcToml(boot, deviceID, localPort)
	if err != nil {
		return err
	}
	frpcToml := filepath.Join(root, "frp", "frpc.toml")
	if err := os.MkdirAll(filepath.Dir(frpcToml), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(frpcToml, []byte(toml), 0o600); err != nil {
		return err
	}
	frpcCmd := filepath.Join(root, "run-frpc.cmd")
	frpcExe := filepath.Join(genRoot, "frp", "frpc.exe")
	frScript := fmt.Sprintf("@echo off\r\ncd /d \"%s\"\r\n\"%s\" -c \"%s\" >> \"%s\" 2>&1\r\n",
		filepath.Dir(frpcExe), frpcExe, frpcToml, filepath.Join(logs, "frpc.log"))
	if err := os.WriteFile(frpcCmd, []byte(frScript), 0o644); err != nil {
		return err
	}
	return registerTask("PhoneRemote-Frpc", frpcCmd)
}

func registerTask(name, cmdPath string) error {
	vbsPath := strings.TrimSuffix(cmdPath, filepath.Ext(cmdPath)) + ".vbs"
	body := "CreateObject(\"Wscript.Shell\").Run \"cmd /c \"\"" + cmdPath + "\"\"\", 0, False\r\n"
	if err := os.WriteFile(vbsPath, []byte(body), 0o644); err != nil {
		return err
	}
	_ = runHidden("schtasks", "/End", "/TN", name)
	_ = runHidden("schtasks", "/Delete", "/TN", name, "/F")
	tr := fmt.Sprintf(`wscript.exe //B //Nologo "%s"`, vbsPath)
	out, err := exec.Command("schtasks", "/Create", "/TN", name, "/TR", tr, "/SC", "ONLOGON", "/RL", "LIMITED", "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("注册开机登录启动“%s”失败：%s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}

func runHidden(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	hide(cmd)
	return cmd.Run()
}

func stopOurTasks() {
	_ = runHidden("schtasks", "/End", "/TN", "PhoneRemote-Node")
	_ = runHidden("schtasks", "/End", "/TN", "PhoneRemote-Frpc")
}

func stopOwnedProcesses(root string) {
	root = strings.ReplaceAll(root, "'", "''")
	script := fmt.Sprintf(`$base = [IO.Path]::GetFullPath('%s'); Get-CimInstance Win32_Process | ForEach-Object { $exe = $_.ExecutablePath; if (-not $exe) { return }; $full = [IO.Path]::GetFullPath($exe); if ($full.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`, root)
	cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
	hide(cmd)
	_ = cmd.Run()
}

func installLogPathFromEnv() string {
	root, err := installRoot()
	if err != nil {
		return filepath.Join("PhoneRemote", "logs", "install.log")
	}
	return filepath.Join(root, "logs", "install.log")
}

func noteInstallLog(line string) string {
	path := installLogPathFromEnv()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = file.WriteString(time.Now().Format("15:04:05 ") + line + "\n")
		_ = file.Close()
	}
	return path
}

func placeShortcuts(root string, port int) error {
	profile := os.Getenv("USERPROFILE")
	appData := os.Getenv("APPDATA")
	if profile == "" || appData == "" {
		return fmt.Errorf("找不到桌面或开始菜单目录")
	}
	exePath := filepath.Join(root, "PhoneRemoteSetup.exe")
	source, err := os.Executable()
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(source), filepath.Clean(exePath)) {
		if err := copyFile(source, exePath); err != nil {
			return err
		}
	}
	files, err := shortcutFiles(exePath, filepath.Join(root, "logs", "install.log"), port)
	if err != nil {
		return err
	}
	dirs := []string{
		filepath.Join(profile, "Desktop"),
		filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "手机远控"),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		for name, body := range files {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func openLocalPage(port int) error {
	return exec.Command("explorer.exe", localAdminEntry(port)).Start()
}

func mustRead(path string) []byte {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return raw
}

func removeEntries() {
	profile := os.Getenv("USERPROFILE")
	appData := os.Getenv("APPDATA")
	files, err := shortcutFiles("unused.exe", "unused.log", 8000)
	if err != nil || profile == "" || appData == "" {
		return
	}
	dirs := []string{
		filepath.Join(profile, "Desktop"),
		filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "手机远控"),
	}
	for _, dir := range dirs {
		for name := range files {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
	_ = os.Remove(filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "手机远控"))
}

func runStop() error {
	if messageBox("停止手机远控", "将停止本机的手机远控计划任务，以及安装目录里的程序。不会删除文件，也不会动其他软件。\r\n\r\n是否继续？", mbYesNo|mbIconWarning) != idYes {
		infoBox("已取消", "没有停止。")
		return nil
	}
	root, err := installRoot()
	if err != nil {
		return err
	}
	noteInstallLog("用户确认停止本机服务")
	stopOurTasks()
	time.Sleep(500 * time.Millisecond)
	stopOwnedProcesses(root)
	infoBox("已停止", "手机远控已停止。桌面和开始菜单里的入口还在。\r\n日志："+installLogPathFromEnv())
	return nil
}

func runUninstall() error {
	if messageBox("卸载手机远控", "将删除本机的手机远控文件，并取消登录后自动启动。桌面上的入口也会失效。\r\n\r\n是否继续？", mbYesNo|mbIconWarning) != idYes {
		infoBox("已取消", "没有卸载。")
		return nil
	}
	root, err := installRoot()
	if err != nil {
		return err
	}
	removeEntries()
	stopOurTasks()
	_ = runHidden("schtasks", "/Delete", "/TN", "PhoneRemote-Node", "/F")
	_ = runHidden("schtasks", "/Delete", "/TN", "PhoneRemote-Frpc", "/F")
	time.Sleep(500 * time.Millisecond)
	stopOwnedProcesses(root)
	if err := os.RemoveAll(root); err != nil {
		return fmt.Errorf("删除 %s 失败：%w", root, err)
	}
	infoBox("已卸载", "手机远控已卸载，登录后自动启动已取消。")
	return nil
}

func tailFile(path string, max int) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "（没有日志）"
	}
	text := string(raw)
	if len(text) > max {
		text = text[len(text)-max:]
	}
	return strings.TrimSpace(text)
}
