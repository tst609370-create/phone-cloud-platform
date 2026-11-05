//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	enableUTF8Console()
	if !acquireInstallLock() {
		infoBox("安装程序已在运行", "已经有一个安装窗口在运行。请不要重复双击，先完成或关闭那个窗口。")
		return
	}
	defer releaseInstallLock()
	fmt.Println("手机远控安装器")
	fmt.Println("此程序未签名。")
	elevated := false
	action := ""
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--elevated":
			elevated = true
		case "--uninstall":
			action = "uninstall"
		case "--install":
			action = "install"
		}
	}
	if !elevated {
		root, err := installRoot()
		already := false
		if err == nil {
			if _, statErr := os.Stat(root); statErr == nil {
				already = true
			}
		}
		if action == "" {
			action = askInstall(already)
		}
		if action == "cancel" {
			fmt.Println("已取消。")
			return
		}
		if !isAdmin() {
			flag := "--install"
			if action == "uninstall" {
				flag = "--uninstall"
			}
			releaseInstallLock()
			if err := relaunchElevated("--elevated " + flag); err != nil {
				errorBox("需要管理员权限", err.Error())
			}
			return
		}
	}
	if action == "" {
		action = "install"
	}
	var err error
	if action == "uninstall" {
		err = runUninstall()
	} else {
		err = runInstall()
	}
	if err != nil {
		fmt.Println("失败：" + err.Error())
		errorBox("没有完成", err.Error()+"\r\n\r\n详细过程在 %LOCALAPPDATA%\\PhoneRemote\\logs\\install.log（不含管理员密码）。")
		os.Exit(1)
	}
}

func init() {
	// Keep the compiler from dropping strings used only by the help text.
	if strings.Contains(serverStepsText(), "\x00") {
		panic("unexpected")
	}
}
