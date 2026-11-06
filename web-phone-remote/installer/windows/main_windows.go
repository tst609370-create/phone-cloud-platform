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
	taskUser := ""
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		switch {
		case arg == "--elevated":
			elevated = true
		case arg == "--uninstall":
			action = "uninstall"
		case arg == "--install":
			action = "install"
		case arg == "--stop":
			action = "stop"
		case arg == "--task-user" && i+1 < len(os.Args):
			i++
			taskUser = os.Args[i]
		case strings.HasPrefix(arg, "--task-user="):
			taskUser = strings.TrimPrefix(arg, "--task-user=")
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
			user, err := currentTaskUser(os.Getenv("USERDOMAIN"), os.Getenv("USERNAME"))
			if err != nil {
				errorBox("没有完成", err.Error())
				return
			}
			params, err := elevatedParameters(action, user)
			if err != nil {
				errorBox("没有完成", err.Error())
				return
			}
			line, _ := handoffLine(action, user)
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
	if taskUser == "" {
		resolved, userErr := currentTaskUser(os.Getenv("USERDOMAIN"), os.Getenv("USERNAME"))
		if userErr != nil && action == "install" {
			errorBox("没有完成", userErr.Error())
			os.Exit(1)
		}
		taskUser = resolved
	}
	if userErr := validateTaskUser(taskUser); userErr != nil && action == "install" {
		errorBox("没有完成", "没有安装前记下的登录用户，拒绝改用提升后的账号注册开机任务："+userErr.Error())
		os.Exit(1)
	}
	logonTaskUser = taskUser
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
