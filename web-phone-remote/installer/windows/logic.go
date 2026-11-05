package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	relayHost      = "103.205.240.23"
	relayPort      = 7000
	remotePortMin  = 10000
	remotePortMax  = 10100
	localPortStart = 8000
	localPortEnd   = 8099
	adminUser      = "admin"
)

// Bootstrap is the per-device enrollment response. The public installer does
// not contain a token; this struct is filled only after a private bootstrap
// the operator runs themselves answers.
type Bootstrap struct {
	ServerAddr string `json:"serverAddr"`
	ServerPort int    `json:"serverPort"`
	RemotePort int    `json:"remotePort"`
	Token      string `json:"token"`
}

type portRecord struct {
	DeviceID string `json:"deviceId"`
	Port     int    `json:"port"`
}

func assignRemotePort(records []portRecord, deviceID string) (int, error) {
	if deviceID == "" {
		return 0, fmt.Errorf("缺少设备编号")
	}
	for _, row := range records {
		if row.DeviceID == deviceID {
			if row.Port < remotePortMin || row.Port > remotePortMax {
				return 0, fmt.Errorf("已记录的端口 %d 不在 %d-%d", row.Port, remotePortMin, remotePortMax)
			}
			return row.Port, nil
		}
	}
	used := map[int]bool{}
	for _, row := range records {
		used[row.Port] = true
	}
	for port := remotePortMin; port <= remotePortMax; port++ {
		if !used[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("%d-%d 端口已分配完", remotePortMin, remotePortMax)
}

func parseBootstrap(body []byte) (Bootstrap, error) {
	var out Bootstrap
	if err := json.Unmarshal(body, &out); err != nil {
		return out, fmt.Errorf("注册响应不是 JSON")
	}
	if out.ServerAddr == "" || out.ServerPort <= 0 {
		return out, fmt.Errorf("注册响应缺少中转地址")
	}
	if out.RemotePort < remotePortMin || out.RemotePort > remotePortMax {
		return out, fmt.Errorf("远端端口 %d 不在 %d-%d，不能占用固定端口", out.RemotePort, remotePortMin, remotePortMax)
	}
	if strings.TrimSpace(out.Token) == "" {
		return out, fmt.Errorf("注册响应没有令牌，安装器不会自己编造令牌")
	}
	if strings.ContainsAny(out.Token, "\"\r\n") {
		return out, fmt.Errorf("令牌含有不能写入配置的字符")
	}
	return out, nil
}

func renderFrpcToml(b Bootstrap, deviceID string, localPort int) (string, error) {
	if _, err := parseBootstrap(mustJSON(b)); err != nil {
		return "", err
	}
	name := "phone-remote-" + deviceID
	if len(name) > 48 {
		name = name[:48]
	}
	return fmt.Sprintf(`serverAddr = "%s"
serverPort = %d
auth.method = "token"
auth.token = "%s"

[[proxies]]
name = "%s"
type = "tcp"
localIP = "127.0.0.1"
localPort = %d
remotePort = %d
`, b.ServerAddr, b.ServerPort, b.Token, name, localPort, b.RemotePort), nil
}

func mustJSON(b Bootstrap) []byte {
	raw, _ := json.Marshal(b)
	return raw
}

func redact(secret, text string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, "[已隐藏]")
}

func newPassword(n int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf), nil
}

func newDeviceID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", buf), nil
}

func serverStepsText() string {
	return `安装器会自动访问 https://103.205.240.23:7443/v1/register ，用户不用填写令牌，也不用放置配置文件。
安装包和源码里没有 FRP 全局令牌。若这次注册失败，公网中转就是未连通，本机 http://127.0.0.1 仍可用。

管理员要在 103.205.240.23 上完成（令牌只放服务器环境变量）：
1. frps 监听 7000，放行 TCP 10000-10100。
2. 本机 127.0.0.1:7100 运行注册服务。新设备只有 ENROLL_OPEN=1 才能登记；关闭后只有已经登记的设备能取回自己的端口。
3. 用 Windows 信任的 HTTPS 证书把 7443 反代到 127.0.0.1:7100。证书必须包含 103.205.240.23。不要让客户端跳过证书校验。
4. 每台电脑得到 10000-10100 中的不同端口，不会写死 10002。

公网明文 HTTP 不能开麦。远程麦克风需要另一张受信任的 HTTPS 证书，本安装包没有。
`
}

func finishText(localPort int, password, credPath string, frpConnected bool, remotePort int) string {
	frp := "公网中转：未连通。没有假装已经连上 103.205.240.23。"
	if frpConnected {
		frp = fmt.Sprintf("公网中转：已写入本机 frpc.toml，远端端口 %d。访问仍是明文 HTTP，电脑麦克风在那个地址上不可用。", remotePort)
	}
	return fmt.Sprintf(`安装完成。

本机地址：http://127.0.0.1:%d
在这台电脑上打开上面的地址才是安全上下文，麦克风才可能使用。
管理员账号：%s
管理员密码：%s
密码同时写在（请勿外传、勿放进压缩包）：%s

%s

此安装包未做代码签名。Windows 可能提示未知发布者。这里不说明如何关闭或绕过系统安全警告。
手机端：打开开发者选项里的 USB 调试，插上数据线并在手机上点允许。
虚拟麦克风 APK 在安装目录的 phone 文件夹。需要你在手机上自行安装，并在已经 root 的手机里用 LSPosed 手动勾选微信。安装器不会自动 root，也不会静默授予 root。
`, localPort, adminUser, password, credPath, frp)
}
