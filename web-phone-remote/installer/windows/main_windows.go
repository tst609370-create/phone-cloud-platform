//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	enableUTF8Console()
	defer func() {
		if rec := recover(); rec != nil {
			detail := fmt.Sprint(rec)
			path := noteInstallLog("安装异常：" + detail)
			errorBox("安装异常", failureBoxText(detail, path))
			os.Exit(1)
		}
	}()
	if !acquireInstallLock() {
		infoBox("安装程序已在运行", "已经有一个安装窗口在运行。请不要重复双击，先完成或关闭那个窗口。")
		return
	}
	defer releaseInstallLock()
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
		case "--stop":
			action = "stop"
		}
	}
	if elevated {
		if err := reopenConsole(); err != nil {
			noteInstallLog(err.Error())
			errorBox("看不到安装窗口", failureBoxText(err.Error(), installLogPathFromEnv()))
		}
	}
	fmt.Println("手机远控安装器")
	fmt.Println("此程序未签名。请不要关闭这个窗口，成功或失败都会再弹出中文说明。")
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
			infoBox("已取消", "没有安装，也没有卸载。")
			return
		}
		if !isAdmin() {
			params, err := elevatedParameters(action)
			if err != nil {
				errorBox("没有完成", err.Error())
				return
			}
			line, _ := handoffLine(action)
			logPath := noteInstallLog(line)
			releaseInstallLock()
			fmt.Println("正在请求管理员权限。请在系统窗口里选择“是”。不要关闭本窗口。")
			code, err := relaunchElevated(params)
			if err != nil {
				errorBox("需要管理员权限", failureBoxText(err.Error(), logPath))
				return
			}
			if code != 0 {
				errorBox("没有完成", failureBoxText(fmt.Sprintf("管理员安装进程退出码 %d", code), logPath))
			}
			return
		}
	}
	if action == "" {
		action = "install"
	}
	var err error
	switch action {
	case "uninstall":
		err = runUninstall()
	case "stop":
		err = runStop()
	default:
		err = runInstall()
	}
	if err != nil {
		fmt.Println("失败：" + err.Error())
		errorBox("没有完成", failureBoxText(err.Error(), installLogPathFromEnv()))
		os.Exit(1)
	}
}

func init() {
	// Keep the compiler from dropping strings used only by the help text.
	if strings.Contains(serverStepsText(), "\x00") {
		panic("unexpected")
	}
}
