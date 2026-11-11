# Point this PC's frpc (%LOCALAPPDATA%\PhoneRemote\frp\frpc.toml) at a new frps relay.
#   $env:RELAY='103.106.189.20'; irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/switch-relay-windows.ps1 | iex
# Asks for the frps token (input hidden, never printed or logged), backs up the old
# config, tries QUIC first and falls back to TCP if QUIC cannot log in within 20s.
# Undo: copy frpc.toml.bak-<time> back to frpc.toml and run: schtasks /Run /TN PhoneRemote-Frpc
$ErrorActionPreference = 'Stop'
$relay = if ($env:RELAY) { $env:RELAY } else { '103.106.189.20' }
$root = Join-Path $env:LOCALAPPDATA 'PhoneRemote'
$toml = Join-Path $root 'frp\frpc.toml'
$log = Join-Path $root 'logs\frpc.log'
if (-not (Test-Path $toml)) { throw "frpc config not found: $toml" }

$sec = Read-Host -AsSecureString "Paste the frps token printed by the server script"
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if ($token -notmatch '^[0-9a-fA-F]{16,}$') { throw 'token looks wrong (expected hex)' }

$orig = [IO.File]::ReadAllText($toml)
$backup = "$toml.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
Copy-Item $toml $backup
Write-Host "backup: $backup"

function Write-Config($protocol) {
    $lines = $orig -split "`r?`n" | Where-Object { $_ -notmatch '^\s*(serverAddr|serverPort|auth\.token|auth\.method|transport\.protocol)\s*=' }
    $head = @(
        "serverAddr = `"$relay`"",
        "serverPort = $(if ($protocol -eq 'quic') { 7002 } else { 7000 })",
        'auth.method = "token"',
        "auth.token = `"$token`"",
        "transport.protocol = `"$protocol`""
    )
    $text = (($head + $lines) -join "`n")
    if ($text -notmatch '(?m)^loginFailExit\s*=') { $text = "loginFailExit = false`n" + $text }
    [IO.File]::WriteAllText($toml, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Restart-Frpc {
    $ErrorActionPreference = 'Continue'
    schtasks /End /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
    Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object { $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep 1
    schtasks /Run /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
}

function Wait-Login {
    $start = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep 1
        if (-not (Test-Path $log)) { continue }
        $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
        try { $fs.Seek($start, 'Begin') | Out-Null; $new = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
        if ($new -match 'start proxy success') { return 'ok' }
        if ($new -match 'port already used|port not allowed|authorization|token') { return 'rejected' }
    }
    return 'timeout'
}

foreach ($p in 'quic', 'tcp') {
    Write-Host "trying $p to $relay ..."
    Write-Config $p
    Restart-Frpc
    $r = Wait-Login
    if ($r -eq 'ok') {
        $port = [regex]::Match($orig, '(?m)^remotePort\s*=\s*(\d+)').Groups[1].Value
        Write-Host "connected via $p. Public address: http://${relay}:$port" -ForegroundColor Green
        return
    }
    Write-Host "  $p failed ($r)" -ForegroundColor Yellow
    if ($r -eq 'rejected') { break }
}
Copy-Item $backup $toml -Force
Restart-Frpc
Write-Host "could not connect to $relay; old config restored. Last log lines:" -ForegroundColor Red
if (Test-Path $log) { Get-Content $log -Tail 15 }
