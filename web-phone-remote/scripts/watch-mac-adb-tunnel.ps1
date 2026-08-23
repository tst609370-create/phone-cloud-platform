param([switch]$Once)

$ErrorActionPreference = 'Stop'

$Ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$Adb = 'C:\ProgramData\WsScrcpyWeb\dependencies\adb\adb.exe'
$Key = 'C:\Users\tst60\.ssh\id_ed25519_mac_access'
$Mac = 'ct@192.168.31.158'
$Endpoints = @('127.0.0.1:16551', '127.0.0.1:16552')
$Ports = @(16551, 16552)
$LogDir = Join-Path $env:LOCALAPPDATA 'WsScrcpyWeb'
$Log = Join-Path $LogDir 'mac-adb-watchdog.log'
$RemoteAdb = '/Users/ct/PhoneProxy/platform-tools-install-20260821/platform-tools/adb'
$RemoteSetup = "ADB='$RemoteAdb'; `$ADB start-server >/dev/null; `$ADB -s 38271FDJH00253 tcpip 5555 >/dev/null; `$ADB -s 54499117053 tcpip 5555 >/dev/null; sleep 1; `$ADB -s 38271FDJH00253 forward tcp:15551 tcp:5555; `$ADB -s 54499117053 forward tcp:15552 tcp:5555"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Created = $false
$Mutex = [Threading.Mutex]::new($true, 'Local\WsScrcpyWebMacAdbTunnel', [ref]$Created)
if (-not $Created) { exit 0 }

function Write-WatchLog([string]$Message) {
    if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 1MB) {
        Move-Item -LiteralPath $Log -Destination "$Log.old" -Force
    }
    Add-Content -LiteralPath $Log -Value "$(Get-Date -Format s) $Message"
}

function Test-TunnelPorts {
    foreach ($Port in $Ports) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { return $false }
    }
    return $true
}

function Repair-RemoteForwards {
    Write-WatchLog 'repairing Mac adb forwards'
    & $Ssh -o BatchMode=yes -o ConnectTimeout=6 -i $Key $Mac $RemoteSetup 2>&1 | ForEach-Object { Write-WatchLog $_ }
}

function Restart-LocalTunnel {
    foreach ($Port in $Ports) {
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
            $OwnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
            if ($OwnerProcess.Name -eq 'ssh.exe' -and $OwnerProcess.CommandLine -match '16551' -and $OwnerProcess.CommandLine -match '16552') {
                Stop-Process -Id $OwnerProcess.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    $Arguments = @(
        '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=6',
        '-i', $Key,
        '-L', '127.0.0.1:16551:127.0.0.1:15551',
        '-L', '127.0.0.1:16552:127.0.0.1:15552',
        $Mac
    )
    Start-Process -FilePath $Ssh -ArgumentList $Arguments -WindowStyle Hidden | Out-Null
    for ($Attempt = 0; $Attempt -lt 16 -and -not (Test-TunnelPorts); $Attempt++) { Start-Sleep -Milliseconds 500 }
    Write-WatchLog "local ssh tunnel listening=$(Test-TunnelPorts)"
}

function Test-AdbDevice([string]$Endpoint) {
    $Escaped = [regex]::Escape($Endpoint)
    return [bool]((& $Adb devices 2>$null) -match "^$Escaped\s+device$")
}

function Connect-AdbDevices {
    foreach ($Endpoint in $Endpoints) {
        if (-not (Test-AdbDevice $Endpoint)) {
            & $Adb disconnect $Endpoint 2>&1 | Out-Null
            $Result = & $Adb connect $Endpoint 2>&1
            Write-WatchLog "adb connect ${Endpoint}: $Result"
        }
    }
}

try {
    Write-WatchLog 'watchdog started'
    $LastRemoteRepair = [datetime]::MinValue
    while ($true) {
        try {
            if (-not (Test-TunnelPorts)) {
                Repair-RemoteForwards
                $LastRemoteRepair = Get-Date
                Restart-LocalTunnel
            }
            Connect-AdbDevices
            $Missing = @($Endpoints | Where-Object { -not (Test-AdbDevice $_) })
            if ($Missing.Count -and ((Get-Date) - $LastRemoteRepair).TotalSeconds -ge 120) {
                Repair-RemoteForwards
                $LastRemoteRepair = Get-Date
                if (-not (Test-TunnelPorts)) { Restart-LocalTunnel }
                Connect-AdbDevices
            }
        } catch {
            Write-WatchLog "repair failed: $($_.Exception.Message)"
        }
        if ($Once) { break }
        Start-Sleep -Seconds 15
    }
} finally {
    $Mutex.ReleaseMutex()
    $Mutex.Dispose()
}
