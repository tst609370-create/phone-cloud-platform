Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\tst60\AppData\Local\WsScrcpyWeb\mac-adb-tunnel-watchdog.ps1"" -Once"
Do
    shell.Run command, 0, True
    WScript.Sleep 30000
Loop
