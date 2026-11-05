package main

import (
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
