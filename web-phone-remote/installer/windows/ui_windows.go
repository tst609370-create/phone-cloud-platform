//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	shell32         = syscall.NewLazyDLL("shell32.dll")
	kernel32        = syscall.NewLazyDLL("kernel32.dll")
	procMessageBox  = user32.NewProc("MessageBoxW")
	procShellExec   = shell32.NewProc("ShellExecuteW")
	procIsAdmin     = shell32.NewProc("IsUserAnAdmin")
	procSetConsole  = kernel32.NewProc("SetConsoleOutputCP")
	procSetConsoleI = kernel32.NewProc("SetConsoleCP")
	procCreateMutex = kernel32.NewProc("CreateMutexW")
	procCloseHandle = kernel32.NewProc("CloseHandle")
)

var installMutex uintptr

const (
	mbYesNo         = 0x00000004
	mbYesNoCancel   = 0x00000003
	mbIconInfo      = 0x00000040
	mbIconWarning   = 0x00000030
	mbIconError     = 0x00000010
	mbSetForeground = 0x00010000
	idYes           = 6
	idNo            = 7
	idCancel        = 2
)

func acquireInstallLock() bool {
	name, _ := syscall.UTF16PtrFromString(`Local\PhoneRemoteSetup`)
	handle, _, err := procCreateMutex.Call(0, 1, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return false
	}
	if errno, ok := err.(syscall.Errno); ok && errno == 183 {
		procCloseHandle.Call(handle)
		return false
	}
	installMutex = handle
	return true
}

func releaseInstallLock() {
	if installMutex != 0 {
		procCloseHandle.Call(installMutex)
		installMutex = 0
	}
}

func enableUTF8Console() {
	procSetConsole.Call(uintptr(65001))
	procSetConsoleI.Call(uintptr(65001))
}

func messageBox(title, text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(title)
	b, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), flags|mbSetForeground)
	return int(r)
}

func isAdmin() bool {
	r, _, _ := procIsAdmin.Call()
	return r != 0
}

func relaunchElevated(args string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString(exe)
	params, _ := syscall.UTF16PtrFromString(args)
	dir, _ := syscall.UTF16PtrFromString("")
	r, _, _ := procShellExec.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), uintptr(unsafe.Pointer(params)), uintptr(unsafe.Pointer(dir)), 1)
	if r <= 32 {
		return fmt.Errorf("没有获得管理员确认（返回值 %d）。安装已取消", r)
	}
	return nil
}

func infoBox(title, text string) {
	messageBox(title, text, mbIconInfo)
}

func errorBox(title, text string) {
	messageBox(title, text, mbIconError)
}

func askInstall(already bool) string {
	if already {
		switch messageBox("手机远控安装", "这台电脑已经安装过手机远控。\r\n\r\n“是”重新安装并设置登录后自动启动。\r\n“否”卸载。\r\n“取消”退出。\r\n\r\n服务只监听 127.0.0.1。安装包未签名。", mbYesNoCancel|mbIconInfo) {
		case idYes:
			return "install"
		case idNo:
			return "uninstall"
		default:
			return "cancel"
		}
	}
	switch messageBox("手机远控安装", "将安装手机远控，并在你登录 Windows 之后自动启动。\r\n\r\n服务只监听本机 127.0.0.1，不会对公网直接开端口。\r\n接下来会请求管理员权限。\r\n\r\n此安装包未做代码签名。这里不说明如何绕过系统安全警告。\r\n\r\n是否继续安装？", mbYesNo|mbIconInfo) {
	case idYes:
		return "install"
	default:
		return "cancel"
	}
}

func askRetry(step string, err error) bool {
	text := fmt.Sprintf("%s失败：\r\n%s\r\n\r\n是否重试？", step, err.Error())
	return messageBox("安装失败", text, mbYesNo|mbIconWarning) == idYes
}
