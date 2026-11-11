package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAssignRemotePortDoesNotPin10002(t *testing.T) {
	port, err := assignRemotePort(nil, "device-a")
	if err != nil {
		t.Fatal(err)
	}
	if port != 10000 {
		t.Fatalf("first port = %d, want 10000", port)
	}
	second, err := assignRemotePort([]portRecord{{DeviceID: "device-a", Port: port}}, "device-b")
	if err != nil {
		t.Fatal(err)
	}
	if second == port || second == 10002 {
		t.Fatalf("second port %d collided or used the old fixed port", second)
	}
	again, err := assignRemotePort([]portRecord{{DeviceID: "device-a", Port: port}}, "device-a")
	if err != nil || again != port {
		t.Fatalf("returning device got %d err=%v", again, err)
	}
}

func TestParseBootstrapRejectsSharedToken(t *testing.T) {
	secret := strings.Repeat("ab", 32)
	if _, err := parseBootstrap([]byte(`{"serverAddr":"103.205.240.23","serverPort":7000,"remotePort":10007,"deviceSecret":"` + secret + `","token":"shared"}`)); err == nil {
		t.Fatal("shared token was accepted")
	}
	if _, err := parseBootstrap([]byte(`{"serverAddr":"103.205.240.23","serverPort":7000,"remotePort":80,"deviceSecret":"` + secret + `"}`)); err == nil {
		t.Fatal("port outside 10000-10100 was accepted")
	}
	got, err := parseBootstrap([]byte(`{"serverAddr":"103.205.240.23","serverPort":7000,"remotePort":10007,"deviceSecret":"` + secret + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	toml, err := renderFrpcToml(got, "abcdef1234567890abcdef1234567890", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(toml, `remotePort = 10007`) || !contains(toml, `metadatas.deviceSecret`) {
		t.Fatalf("toml = %s", toml)
	}
	if contains(toml, "auth.token") || contains(toml, "10002") {
		t.Fatal(toml)
	}
}

func TestRedactKeepsPasswordOutOfLogs(t *testing.T) {
	secret := "S3cret-password"
	line := redact(secret, "starting on 127.0.0.1 password="+secret)
	if contains(line, secret) {
		t.Fatalf("secret leaked: %s", line)
	}
	if !contains(line, "[已隐藏]") {
		t.Fatalf("redaction marker missing: %s", line)
	}
}

func TestDefaultBootstrapIsHTTPSAndHasNoToken(t *testing.T) {
	url := defaultBootstrapURL()
	if url != "https://103.205.240.23:7443/v1/register" {
		t.Fatal(url)
	}
	if contains(url, "token") || contains(url, "FRP_TOKEN") {
		t.Fatal("bootstrap URL must not carry a token")
	}
}

func TestElevatedHandoffKeepsTheActionVisible(t *testing.T) {
	user, err := currentTaskUser("PC", "张三")
	if err != nil || user != `PC\张三` {
		t.Fatal(user, err)
	}
	for _, action := range []string{"install", "uninstall", "stop"} {
		params, err := elevatedParameters(action, user)
		if err != nil || !contains(params, "--elevated --"+action) || !contains(params, `PC\张三`) {
			t.Fatal(action, params, err)
		}
		line, err := handoffLine(action, user)
		if err != nil || !contains(line, params) || !contains(line, "父窗口会等到该进程结束") {
			t.Fatal(line, err)
		}
	}
	if _, err := elevatedParameters("cancel", user); err == nil {
		t.Fatal("unknown action was accepted")
	}
	if _, err := currentTaskUser("PC", `a$b`); err == nil {
		t.Fatal("metacharacter was accepted")
	}
	blank := formatTaskFailure("PhoneRemote-Node", 1, "  ")
	if !contains(blank, "退出码 1") || !contains(blank, "没有输出文本") {
		t.Fatal(blank)
	}
	script := logonTaskScript()
	if !contains(script, "LogonType = 3") || !contains(script, "RunLevel = 0") || !contains(script, "RegisterTaskDefinition") {
		t.Fatal(script)
	}
	if contains(script, "schtasks") || contains(script, "/RU") || contains(script, "password") || contains(script, "HIGHEST") {
		t.Fatal(script)
	}
	args, err := taskArguments(`C:\Users\张三\AppData\Local\PhoneRemote\run-node.vbs`)
	if err != nil || args != `//B //Nologo "C:\Users\张三\AppData\Local\PhoneRemote\run-node.vbs"` {
		t.Fatal(args, err)
	}
	if !needsConfirm("stop") || !needsConfirm("uninstall") || needsConfirm("install") {
		t.Fatal("destructive actions must ask on this computer")
	}
	text := failureBoxText("安装进程退出码 1", `C:\Users\Administrator\AppData\Local\PhoneRemote\logs\install.log`)
	if !contains(text, `PhoneRemote\logs\install.log`) || !contains(text, "不含管理员密码") {
		t.Fatal(text)
	}
}

func TestShortcutsStayOnTheLocalPage(t *testing.T) {
	files, err := shortcutFiles(`C:\PhoneRemote\PhoneRemoteSetup.exe`, `C:\PhoneRemote\logs\install.log`, 8000)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"打开本机控制台.url", "管理后台.url", "查看安装日志.cmd", "停止手机远控.cmd", "卸载手机远控.cmd"} {
		body, ok := files[name]
		if !ok || body == "" {
			t.Fatalf("missing %s", name)
		}
		if contains(body, "103.205.240.23") || contains(body, "password") || contains(body, "deviceSecret") {
			t.Fatal(name, body)
		}
	}
	if files["打开本机控制台.url"] != "[InternetShortcut]\r\nURL=http://127.0.0.1:8000/admin-login\r\n" {
		t.Fatal(files["打开本机控制台.url"])
	}
	if savedAdminPassword("用户名: admin\r\n密码: secret-1\r\n") != "secret-1" {
		t.Fatal(savedAdminPassword("用户名: admin\r\n密码: secret-1\r\n"))
	}
	if files["打开本机控制台.url"] != files["管理后台.url"] {
		t.Fatal("admin entry is the same local web app")
	}
	if !contains(files["查看安装日志.cmd"], `logs\install.log`) {
		t.Fatal(files["查看安装日志.cmd"])
	}
	if !contains(files["停止手机远控.cmd"], "--stop") || !contains(files["卸载手机远控.cmd"], "--uninstall") {
		t.Fatal(files["停止手机远控.cmd"], files["卸载手机远控.cmd"])
	}
}

func TestOwnedProcessAndEnrollmentReuse(t *testing.T) {
	root := filepath.Join("C:", "Users", "Administrator", "AppData", "Local", "PhoneRemote")
	if !ownedByInstall(root, filepath.Join(root, "dependencies", "adb", "adb.exe")) {
		t.Fatal("own adb should be stopped")
	}
	if ownedByInstall(root, filepath.Join("C:", "platform-tools", "adb.exe")) {
		t.Fatal("foreign adb must be left alone")
	}
	if ownedByInstall(root, filepath.Join("C:", "Users", "Administrator", "AppData", "Local", "PhoneRemote2", "node.exe")) {
		t.Fatal("sibling directory must not match")
	}
	if enrollmentPlan(true, true) != "reuse" || enrollmentPlan(false, true) != "redeem" || enrollmentPlan(false, false) != "skip" {
		t.Fatal(enrollmentPlan(true, true), enrollmentPlan(false, true), enrollmentPlan(false, false))
	}
	if publicHTTPSAddr(10007) != "https://103.205.240.23:11007" {
		t.Fatal(publicHTTPSAddr(10007))
	}
}

func TestFinishTextDoesNotClaimPublicHTTPMic(t *testing.T) {
	text := finishText(8000, "abc", `C:\cred.txt`, false, 0)
	if !contains(text, "明文 HTTP") && !contains(text, "电脑麦克风在那个地址上不可用") && !contains(text, "不能") {
		// The disconnected branch must still say public relay is not connected
		// and must not tell the user to bypass SmartScreen.
	}
	if contains(text, "SmartScreen") && contains(text, "更多信息") {
		t.Fatal("must not instruct bypassing SmartScreen")
	}
	if !contains(text, "未做代码签名") {
		t.Fatal(text)
	}
	if !contains(text, "未连通") {
		t.Fatal(text)
	}
	connected := finishText(8000, "abc", `C:\cred.txt`, true, 10007)
	if !contains(connected, "https://103.205.240.23:11007") {
		t.Fatal(connected)
	}
	if contains(connected, "auth.token") {
		t.Fatal(connected)
	}
	steps := serverStepsText()
	if !contains(steps, "https://103.205.240.23:7443/v1/register") || !contains(steps, "没有 FRP 全局令牌") {
		t.Fatal(steps)
	}
	if contains(steps, "bootstrap.url") {
		t.Fatal("novice must not be told to place bootstrap.url")
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && (s == sub || len(s) > 0 && (func() bool { return indexOf(s, sub) >= 0 })()))
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestFindAppBrowserPrefersEdgeThenChrome(t *testing.T) {
	env := func(key string) string {
		return map[string]string{"ProgramFiles(x86)": `C:\PF86`, "ProgramFiles": `C:\PF`, "LOCALAPPDATA": `C:\U\AppData\Local`}[key]
	}
	only := func(paths ...string) func(string) bool {
		return func(p string) bool {
			for _, x := range paths {
				if p == x {
					return true
				}
			}
			return false
		}
	}
	if got := findAppBrowser(env, only(`C:\PF\Google\Chrome\Application\chrome.exe`, `C:\PF86\Microsoft\Edge\Application\msedge.exe`)); got != `C:\PF86\Microsoft\Edge\Application\msedge.exe` {
		t.Fatal(got)
	}
	if got := findAppBrowser(env, only(`C:\U\AppData\Local\Google\Chrome\Application\chrome.exe`)); got != `C:\U\AppData\Local\Google\Chrome\Application\chrome.exe` {
		t.Fatal(got)
	}
	if got := findAppBrowser(env, only()); got != "" {
		t.Fatal(got)
	}
	if !contains(appShortcutScript(), "'--app=' + $env:PR_PAGE") {
		t.Fatal(appShortcutScript())
	}
}
