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

// Bootstrap is the per-device enrollment response. It carries the device
// secret returned once at invite redemption, never the shared FRP token.
type Bootstrap struct {
	ServerAddr   string `json:"serverAddr"`
	ServerPort   int    `json:"serverPort"`
	RemotePort   int    `json:"remotePort"`
	DeviceSecret string `json:"deviceSecret"`
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
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return Bootstrap{}, fmt.Errorf("注册响应不是 JSON")
	}
	if _, ok := raw["token"]; ok {
		return Bootstrap{}, fmt.Errorf("注册响应包含 token 字段，已拒绝")
	}
	var out Bootstrap
	if err := json.Unmarshal(body, &out); err != nil {
		return Bootstrap{}, fmt.Errorf("注册响应不是 JSON")
	}
	if out.ServerAddr == "" || out.ServerPort <= 0 {
		return out, fmt.Errorf("注册响应缺少中转地址")
	}
	if out.RemotePort < remotePortMin || out.RemotePort > remotePortMax {
		return out, fmt.Errorf("远端端口 %d 不在 %d-%d，不能占用固定端口", out.RemotePort, remotePortMin, remotePortMax)
	}
	if len(out.DeviceSecret) != 64 || strings.ContainsAny(out.DeviceSecret, "\"\r\n") {
		return out, fmt.Errorf("注册响应没有设备密钥")
	}
	for _, c := range out.DeviceSecret {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return out, fmt.Errorf("注册响应没有设备密钥")
		}
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
user = "%s"
metadatas.deviceSecret = "%s"

[[proxies]]
name = "%s"
type = "tcp"
localIP = "127.0.0.1"
localPort = %d
remotePort = %d
`, b.ServerAddr, b.ServerPort, deviceID, b.DeviceSecret, name, localPort, b.RemotePort), nil
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
	return `安装器会自动访问 https://103.205.240.23:7443/v1/register 。公共安装包没有邀请，不会注册。
私人安装包里的一次性邀请由服务器兑付并绑定这台电脑。之后取配置要靠设备自己的密钥。
安装包和源码里没有 FRP 全局令牌。注册失败或没有邀请时，公网中转就是未连通。

frps 插件只能在它自己的令牌校验通过之后限制端口。没有插件时，持有共享令牌的客户端仍能占用允许范围内的端口。本安装器不发放共享令牌，所以不能把它当成隧道已经可用。

公网明文 HTTP 不能开麦。远程麦克风需要另一张受信任的 HTTPS 证书，本安装包没有。
`
}

func finishText(localPort int, password, credPath string, frpConnected bool, remotePort int) string {
	frp := "公网中转：未连通。没有邀请或注册失败时不会占用端口，也没有发放共享令牌。"
	if frpConnected {
		frp = fmt.Sprintf("已兑付邀请并写入本机 frpc 配置，远端端口 %d。配置里没有 FRP 共享令牌。隧道能否连上取决于 frps 自己的鉴权，这里不能当成已经可用。访问仍是明文 HTTP，电脑麦克风在那个地址上不可用。", remotePort)
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
