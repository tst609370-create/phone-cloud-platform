# Connect this PC's phone-remote service to an frps relay (works on any PC that has the
# PhoneRemote installer, with or without an existing frpc setup):
#   $env:RELAY='1.2.3.4'; irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/switch-relay-windows.ps1 | iex
# - asks for the frps token (hidden input, never printed or logged)
# - reuses frpc.exe from the installer, or downloads it (GitHub, then CN mirrors)
# - keeps the existing remote port; without one it picks a free port in 10000-10100
#   (if the relay says the port is taken, it tries the next one)
# - tries QUIC first, then TCP; if nothing works the old config is restored
# - frpc restarts itself 10s after exiting and starts at logon
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$relay = "$env:RELAY".Trim()
if (-not $relay) { $relay = (Read-Host 'Relay server IP').Trim() }
if ($relay -notmatch '^[0-9A-Za-z.\-]+$') { throw "bad relay address: $relay" }
$root = Join-Path $env:LOCALAPPDATA 'PhoneRemote'
$runNode = Join-Path $root 'run-node.cmd'
if (-not (Test-Path $runNode)) { throw "PhoneRemote is not installed on this PC ($runNode missing)" }
$localPort = [regex]::Match((Get-Content $runNode -Raw), 'set "PORT=(\d+)"').Groups[1].Value
if (-not $localPort) { throw 'cannot find PORT in run-node.cmd' }
$frpDir = Join-Path $root 'frp'
$toml = Join-Path $frpDir 'frpc.toml'
$logs = Join-Path $root 'logs'
$log = Join-Path $logs 'frpc.log'
$runCmd = Join-Path $root 'run-frpc.cmd'
$runVbs = Join-Path $root 'run-frpc.vbs'
New-Item -ItemType Directory -Force -Path $frpDir, $logs | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

# --- frpc.exe ---
$exe = Get-ChildItem (Join-Path $root 'generations') -Recurse -Filter frpc.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $exe) { $exe = Join-Path $frpDir 'bin\frpc.exe' }
if (-not (Test-Path $exe)) {
    $ver = '0.65.0'
    $zip = Join-Path $env:TEMP "frp_$ver.zip"
    $ok = $false
    foreach ($base in 'https://github.com', 'https://ghfast.top/https://github.com', 'https://gh-proxy.com/https://github.com') {
        try {
            Write-Host "downloading frpc from $base ..."
            Invoke-WebRequest "$base/fatedier/frp/releases/download/v$ver/frp_${ver}_windows_amd64.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 180
            $ok = $true; break
        } catch { Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    if (-not $ok) { throw 'could not download frpc' }
    $tmp = Join-Path $env:TEMP "frp_$ver"
    Expand-Archive $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $exe) | Out-Null
    Copy-Item (Join-Path $tmp "frp_${ver}_windows_amd64\frpc.exe") $exe -Force
}
Write-Host "frpc: $exe"

# --- token ---
$sec = Read-Host -AsSecureString 'Paste the frps token printed by the server script'
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if ($token -notmatch '^[0-9a-fA-F]{16,}$') { throw 'token looks wrong (expected hex)' }

# --- existing config ---
$backup = $null
$port = 0
$proxyName = 'phone-remote-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9]', '').ToLower()
if (Test-Path $toml) {
    $orig = [IO.File]::ReadAllText($toml)
    $backup = "$toml.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
    Copy-Item $toml $backup
    Write-Host "backup: $backup"
    $m = [regex]::Match($orig, '(?m)^remotePort\s*=\s*(\d+)'); if ($m.Success) { $port = [int]$m.Groups[1].Value }
    $m = [regex]::Match($orig, '(?m)^name\s*=\s*"([^"]+)"'); if ($m.Success) { $proxyName = $m.Groups[1].Value }
}
$origCmd = if (Test-Path $runCmd) { [IO.File]::ReadAllText($runCmd) } else { $null }
if ($port -lt 10000 -or $port -gt 10100) { $port = 10000 + (Get-Random -Maximum 101) }

function Write-Config($protocol, $remotePort) {
    $text = @(
        "serverAddr = `"$relay`"",
        "serverPort = $(if ($protocol -eq 'quic') { 7002 } else { 7000 })",
        'loginFailExit = false',
        'auth.method = "token"',
        "auth.token = `"$token`"",
        "transport.protocol = `"$protocol`"",
        '',
        '[[proxies]]',
        "name = `"$proxyName`"",
        'type = "tcp"',
        'localIP = "127.0.0.1"',
        "localPort = $localPort",
        "remotePort = $remotePort"
    ) -join "`n"
    [IO.File]::WriteAllText($toml, $text + "`n", $utf8)
}

# --- self-restarting launcher + logon start ---
$cmdText = "@echo off`r`ncd /d `"$(Split-Path $exe)`"`r`n:loop`r`n`"$exe`" -c `"$toml`" >> `"$log`" 2>&1`r`nping -n 11 127.0.0.1 >nul`r`ngoto loop`r`n"
[IO.File]::WriteAllText($runCmd, $cmdText, $utf8)
[IO.File]::WriteAllText($runVbs, "CreateObject(`"Wscript.Shell`").Run `"cmd /c `"`"$runCmd`"`"`", 0, False`r`n", [Text.Encoding]::Unicode)
$ErrorActionPreference = 'Continue'
schtasks /Query /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
$hasTask = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $hasTask) {
    $startup = [Environment]::GetFolderPath('Startup')
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'PhoneRemote-Frpc.lnk'))
    $sc.TargetPath = 'wscript.exe'
    $sc.Arguments = "//B //Nologo `"$runVbs`""
    $sc.Save()
    Write-Host 'frpc will start at logon (Startup folder shortcut)'
}

function Restart-Frpc {
    $ErrorActionPreference = 'Continue'
    schtasks /End /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*run-frpc.cmd*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object { $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $ErrorActionPreference = 'Stop'
    Start-Sleep 1
    Start-Process wscript.exe -ArgumentList '//B', '//Nologo', "`"$runVbs`"" -WindowStyle Hidden
}

function Wait-Result {
    $start = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep 1
        if (-not (Test-Path $log)) { continue }
        $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
        try { [void]$fs.Seek($start, 'Begin'); $new = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
        if ($new -match 'start proxy success') { return 'ok' }
        if ($new -match 'port (already used|unavailable|not allowed)|already in use') { return 'port' }
        if ($new -match 'token|authorization') { return 'auth' }
    }
    return 'timeout'
}

$result = 'timeout'
foreach ($p in 'quic', 'tcp') {
    for ($try = 0; $try -lt 8; $try++) {
        Write-Host "trying $p, remote port $port ..."
        Write-Config $p $port
        Restart-Frpc
        $result = Wait-Result
        if ($result -ne 'port') { break }
        Write-Host "  port $port is taken on the relay, trying another"
        $port = 10000 + (($port - 10000 + 1) % 101)
    }
    if ($result -eq 'ok') {
        Write-Host "connected via $p. Public address: http://${relay}:$port" -ForegroundColor Green
        return
    }
    Write-Host "  $p failed ($result)" -ForegroundColor Yellow
    if ($result -eq 'auth') { break }
}
if ($backup) { Copy-Item $backup $toml -Force } else { Remove-Item $toml -Force }
if ($origCmd) { [IO.File]::WriteAllText($runCmd, $origCmd, $utf8) }
if ($backup) { Restart-Frpc } else { Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object { $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }
Write-Host "could not connect to ${relay}: $result. Old config restored. Last log lines:" -ForegroundColor Red
if (Test-Path $log) { Get-Content $log -Tail 15 }
