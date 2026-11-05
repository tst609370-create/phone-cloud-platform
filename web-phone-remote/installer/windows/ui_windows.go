//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	shell32          = syscall.NewLazyDLL("shell32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procMessageBox   = user32.NewProc("MessageBoxW")
	procIsAdmin      = shell32.NewProc("IsUserAnAdmin")
	procSetConsole   = kernel32.NewProc("SetConsoleOutputCP")
	procSetConsoleI  = kernel32.NewProc("SetConsoleCP")
	procCreateMutex  = kernel32.NewProc("CreateMutexW")
	procCloseHandle  = kernel32.NewProc("CloseHandle")
	procShellEx      = shell32.NewProc("ShellExecuteExW")
	procWait         = kernel32.NewProc("WaitForSingleObject")
	procExitCode     = kernel32.NewProc("GetExitCodeProcess")
	procFreeConsole  = kernel32.NewProc("FreeConsole")
	procAllocConsole = kernel32.NewProc("AllocConsole")
	procSetTitle     = kernel32.NewProc("SetConsoleTitleW")
)

var installMutex uintptr

const (
	mbYesNo         = 0x00000004
	mbYesNoCancel   = 0x00000003
	mbIconInfo      = 0x00000040
	mbIconWarning   = 0x00000030
	mbIconError     = 0x00000010
	mbSetForeground = 0x00010000
	mbTopMost       = 0x00040000
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
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), flags|mbSetForeground|mbTopMost)
	return int(r)
}

func isAdmin() bool {
	r, _, _ := procIsAdmin.Call()
	return r != 0
}

func relaunchElevated(args string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString(exe)
	params, _ := syscall.UTF16PtrFromString(args)
	var sei struct {
		cbSize       uint32
		fMask        uint32
		hwnd         uintptr
		lpVerb       *uint16
		lpFile       *uint16
		lpParameters *uint16
		lpDirectory  *uint16
		nShow        int32
		hInstApp     uintptr
		lpIDList     uintptr
		lpClass      *uint16
		hkeyClass    uintptr
		dwHotKey     uint32
		hIcon        uintptr
		hProcess     uintptr
	}
	sei.cbSize = uint32(unsafe.Sizeof(sei))
	if sei.cbSize != 112 {
		return 1, fmt.Errorf("内部错误：提权参数大小 %d", sei.cbSize)
	}
	sei.fMask = 0x00000040
	sei.lpVerb = verb
	sei.lpFile = file
	sei.lpParameters = params
	sei.nShow = 1
	r, _, callErr := procShellEx.Call(uintptr(unsafe.Pointer(&sei)))
	if r == 0 {
		return 1, fmt.Errorf("没有获得管理员确认（%v）。安装已取消", callErr)
	}
	if sei.hProcess == 0 {
		return 1, fmt.Errorf("系统没有返回管理员安装进程。安装已取消")
	}
	defer procCloseHandle.Call(sei.hProcess)
	wait, _, _ := procWait.Call(sei.hProcess, 0xFFFFFFFF)
	if wait != 0 {
		return 1, fmt.Errorf("没能等到管理员安装进程结束")
	}
	var code uint32
	procExitCode.Call(sei.hProcess, uintptr(unsafe.Pointer(&code)))
	return int(code), nil
}

func reopenConsole() error {
	procFreeConsole.Call()
	r, _, err := procAllocConsole.Call()
	if r == 0 {
		return fmt.Errorf("无法打开安装窗口：%v", err)
	}
	title, _ := syscall.UTF16PtrFromString("手机远控安装")
	procSetTitle.Call(uintptr(unsafe.Pointer(title)))
	out, err := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	if err != nil {
		return err
	}
	errHandle, err := syscall.GetStdHandle(syscall.STD_ERROR_HANDLE)
	if err != nil {
		return err
	}
	os.Stdout = os.NewFile(uintptr(out), "stdout")
	os.Stderr = os.NewFile(uintptr(errHandle), "stderr")
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
