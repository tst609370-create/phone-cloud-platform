//go:build windows

package main

import (
	"archive/zip"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	count := 0
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		dest, err := safeJoin(root, file.Name)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := writeZipFile(file, dest); err != nil {
			return err
		}
		count++
		if count%40 == 0 {
			log.printf("已释放 %d 个文件", count)
		}
	}
	log.printf("已释放 %d 个文件", count)
	if _, err := os.Stat(filepath.Join(root, "runtime", "node", "node.exe")); err != nil {
		return fmt.Errorf("安装包里没有 node.exe")
	}
	if _, err := os.Stat(filepath.Join(root, "app", "dist", "index.js")); err != nil {
		return fmt.Errorf("安装包里没有远控程序")
	}
	return configureAndStart(root, log, invite)
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

func configureAndStart(root string, log *installerLog, invite string) error {
	state := filepath.Join(root, "state")
	deps := filepath.Join(root, "dependencies")
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
	nodeExe := filepath.Join(root, "runtime", "node", "node.exe")
	script := fmt.Sprintf("@echo off\r\nsetlocal\r\nset \"WS_SCRCPY_BIND_HOST=127.0.0.1\"\r\nset \"WS_SCRCPY_CONFIG=%s\"\r\nset \"DEPS_PATH=%s\"\r\nset \"PORT=%d\"\r\nset \"WS_SCRCPY_NO_BROWSER=1\"\r\ncd /d \"%s\"\r\n\"%s\" dist\\index.js >> \"%s\" 2>&1\r\n",
		configPath, deps, localPort, filepath.Join(root, "app"), nodeExe, filepath.Join(logs, "node.log"))
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
	if invite != "" {
		log.printf("正在兑付一次性邀请")
		boot, err := enroll(bootstrapURL(), deviceID, invite)
		if err != nil {
			frpNote = "邀请兑付失败，公网中转未连通：" + err.Error()
			log.printf("%s", frpNote)
		} else {
			log.hide(boot.DeviceSecret)
			toml, err := renderFrpcToml(boot, deviceID, localPort)
			if err != nil {
				return err
			}
			frpcToml := filepath.Join(root, "frp", "frpc.toml")
			if err := os.WriteFile(frpcToml, []byte(toml), 0o600); err != nil {
				return err
			}
			frpcCmd := filepath.Join(root, "run-frpc.cmd")
			frpcExe := filepath.Join(root, "frp", "frpc.exe")
			frScript := fmt.Sprintf("@echo off\r\ncd /d \"%s\"\r\n\"%s\" -c \"%s\" >> \"%s\" 2>&1\r\n",
				filepath.Join(root, "frp"), frpcExe, frpcToml, filepath.Join(logs, "frpc.log"))
			if err := os.WriteFile(frpcCmd, []byte(frScript), 0o644); err != nil {
				return err
			}
			if err := registerTask("PhoneRemote-Frpc", frpcCmd); err != nil {
				return err
			}
			connected = true
			remotePort = boot.RemotePort
			frpNote = fmt.Sprintf("已为本机分配远端端口 %d。未写入共享令牌。", remotePort)
			log.printf("公网配置已写入本机。设备密钥已隐藏。隧道是否连通要等 frps 插件，这里不视为已可用。")
		}
	} else {
		_ = os.Remove(filepath.Join(root, "frp", "frpc.toml"))
		_ = exec.Command("schtasks", "/Delete", "/TN", "PhoneRemote-Frpc", "/F").Run()
		log.printf("%s", frpNote)
	}
	stepsPath := filepath.Join(root, "服务端步骤.txt")
	_ = os.WriteFile(stepsPath, []byte(serverStepsText()), 0o644)
	_ = os.WriteFile(filepath.Join(state, "frp-status.txt"), []byte(frpNote+"\r\n"), 0o644)

	var password string
	if err := withRetry(log, "启动本机服务并开启登录", func() error {
		got, err := bootAuth(root, configPath, deps, localPort, log)
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
	infoBox("安装完成", finishText(localPort, password, cred, connected, remotePort))
	return nil
}

func bootAuth(root, configPath, deps string, localPort int, log *installerLog) (string, error) {
	_ = stopOurs(root)
	node := filepath.Join(root, "runtime", "node", "node.exe")
	cmd := exec.Command(node, "dist\\index.js")
	cmd.Dir = filepath.Join(root, "app")
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
	auth := exec.Command(node, filepath.Join(root, "tools", "setup-auth.mjs"))
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
	cred := fmt.Sprintf("PhoneRemote 本机凭证。不要发送给别人，不要放进压缩包。\r\n用户名: %s\r\n密码: %s\r\n本机地址: http://127.0.0.1:%d\r\n", adminUser, password, localPort)
	credPath := filepath.Join(root, "credentials.txt")
	if err := os.WriteFile(credPath, []byte(cred), 0o600); err != nil {
		return "", err
	}
	if err := exec.Command("schtasks", "/Run", "/TN", "PhoneRemote-Node").Run(); err != nil {
		return "", fmt.Errorf("计划任务没有启动服务：%w", err)
	}
	if !waitPort(localPort, 90*time.Second) {
		return "", fmt.Errorf("计划任务启动后 %d 端口仍不可用，请查看 logs\\node.log", localPort)
	}
	_ = exec.Command("schtasks", "/Run", "/TN", "PhoneRemote-Frpc").Run()
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
	reqBody := strings.NewReader(body)
	client := &httpClientTimeout{timeout: 20 * time.Second}
	raw, err := client.post(url, reqBody)
	if err != nil {
		return Bootstrap{}, fmt.Errorf("联系注册服务失败：%w", err)
	}
	return parseBootstrap(raw)
}

func registerTask(name, cmdPath string) error {
	_ = exec.Command("schtasks", "/Delete", "/TN", name, "/F").Run()
	out, err := exec.Command("schtasks", "/Create", "/TN", name, "/TR", `"`+cmdPath+`"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("注册开机登录启动“%s”失败：%s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

func stopOurs(root string) error {
	script := fmt.Sprintf(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '%s*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`, strings.ReplaceAll(root, "'", "''"))
	return exec.Command("powershell", "-NoProfile", "-Command", script).Run()
}

func runUninstall() error {
	root, err := installRoot()
	if err != nil {
		return err
	}
	_ = exec.Command("schtasks", "/Delete", "/TN", "PhoneRemote-Node", "/F").Run()
	_ = exec.Command("schtasks", "/Delete", "/TN", "PhoneRemote-Frpc", "/F").Run()
	_ = stopOurs(root)
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
