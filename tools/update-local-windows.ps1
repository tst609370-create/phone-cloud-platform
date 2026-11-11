# 把本机已安装的“手机远程控制”（%LOCALAPPDATA%\PhoneRemote）更新到 GitHub main 的最新代码。
# 只换 app\dist（前端页面 + 服务端打包），不动配置、账号、租用数据、FRP；旧 dist 会备份。
# 用法（PowerShell）：irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/update-local-windows.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 默认可能没开 TLS 1.2
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

$root = Join-Path $env:LOCALAPPDATA 'PhoneRemote'
$runCmd = Join-Path $root 'run-node.cmd'
if (-not (Test-Path $runCmd)) { throw "没找到 $runCmd ，这台电脑上好像没装手机远程控制安装包。" }

Step '定位当前运行的程序'
$text = Get-Content $runCmd -Raw
$appDir = [regex]::Match($text, 'cd /d "([^"]+)"').Groups[1].Value
$nodeExe = [regex]::Match($text, '"([^"]+node\.exe)"').Groups[1].Value
if (-not $appDir -or -not (Test-Path (Join-Path $appDir 'dist\index.js'))) { throw "run-node.cmd 里找不到 app 目录：$appDir" }
Write-Host "app 目录：$appDir"

$work = Join-Path $env:TEMP ("phone-remote-update-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $work | Out-Null

Step '准备 Node 24（构建用，不影响已安装的运行时）'
$nodeDir = Join-Path $work 'node'
# PowerShell 5.1 的 Invoke-RestMethod 会把 JSON 数组当成一个整体送进管道，所以先 @() 展开再逐个找
$ver = $null
try {
    $index = @(Invoke-RestMethod 'https://nodejs.org/dist/index.json')
    foreach ($item in $index) { foreach ($entry in @($item)) { if (-not $ver -and "$($entry.version)" -like 'v24.*') { $ver = "$($entry.version)" } } }
} catch { Write-Host "读取 Node 版本列表失败，改用固定版本：$($_.Exception.Message)" }
if (-not $ver -or $ver -notmatch '^v24\.\d+\.\d+$') { $ver = 'v24.22.2' }
$zip = Join-Path $work 'node.zip'
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $work
Rename-Item (Join-Path $work "node-$ver-win-x64") 'node'
$env:PATH = "$nodeDir;$env:PATH"
Write-Host "Node $ver"

Step '下载 main 最新代码'
$src = Join-Path $work 'src.zip'
Invoke-WebRequest 'https://codeload.github.com/tst609370-create/phone-cloud-platform/zip/refs/heads/main' -OutFile $src
Expand-Archive $src -DestinationPath $work
$repo = Join-Path $work 'phone-cloud-platform-main\web-phone-remote'

Step '构建（npm ci + webpack，约 2–5 分钟）'
Push-Location $repo
try {
    & npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    & npx webpack --config webpack/ws-scrcpy-web.prod.ts
    if ($LASTEXITCODE -ne 0) { throw 'webpack 构建失败' }
} finally { Pop-Location }
$newDist = Join-Path $repo 'dist'
foreach ($f in 'index.js', 'public\tianxi.css', 'public\login-assets\globe.js') {
    if (-not (Test-Path (Join-Path $newDist $f))) { throw "构建结果缺少 $f" }
}

Step '停止服务、备份并替换 dist'
# 5.1 下给原生命令重定向 stderr 会触发 Stop，这里临时放宽
$ErrorActionPreference = 'Continue'
schtasks /End /TN 'PhoneRemote-Node' 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $nodeExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
$backup = Join-Path $appDir ("dist.bak-" + (Get-Date -Format 'yyyyMMddHHmmss'))
Move-Item (Join-Path $appDir 'dist') $backup  # 若提示文件被占用，说明服务还没停，等几秒重跑即可
Copy-Item $newDist (Join-Path $appDir 'dist') -Recurse
Write-Host "旧版本备份在：$backup"

Step '公网中转（frpc）断线自愈'
# 旧安装的 frpc 首次登录失败会直接退出且没人拉起，公网入口要等重启电脑才恢复。
# 这里给配置加 loginFailExit = false，给启动脚本加退出后 10 秒重启的循环。没装 frpc 的跳过。
$frpcToml = Join-Path $root 'frp\frpc.toml'
$frpcCmd = Join-Path $root 'run-frpc.cmd'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$frpcChanged = $false
if ((Test-Path $frpcToml) -and (Test-Path $frpcCmd)) {
    $t = [IO.File]::ReadAllText($frpcToml)
    if ($t -notmatch '(?m)^\s*loginFailExit\s*=') {
        $t = [regex]::Replace($t, '(?m)^(serverPort\s*=[^\r\n]*)', "`$1`nloginFailExit = false")
        [IO.File]::WriteAllText($frpcToml, $t, $utf8); $frpcChanged = $true
    }
    $c = [IO.File]::ReadAllText($frpcCmd)
    if ($c -notmatch '(?m)^:loop') {
        $c = [regex]::Replace($c, '(?m)^("[^\r\n]*frpc\.exe"[^\r\n]*)', ":loop`r`n`$1`r`nping -n 11 127.0.0.1 >nul`r`ngoto loop")
        [IO.File]::WriteAllText($frpcCmd, $c, $utf8); $frpcChanged = $true
    }
    if ($frpcChanged) {
        $ErrorActionPreference = 'Continue'
        schtasks /End /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
        Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        schtasks /Run /TN 'PhoneRemote-Frpc' 2>&1 | Out-Null
        $ErrorActionPreference = 'Stop'
        Write-Host '已更新 frpc：登录失败会自动重试，进程退出 10 秒后自动重启。'
    } else { Write-Host 'frpc 已是自愈配置。' }
} else { Write-Host '本机没装 frpc 公网中转，跳过。' }

Step '重新启动'
schtasks /Run /TN 'PhoneRemote-Node' | Out-Null
$port = [regex]::Match($text, 'set "PORT=(\d+)"').Groups[1].Value
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Seconds 2
    try {
        $page = Invoke-WebRequest "http://127.0.0.1:$port/admin-login" -UseBasicParsing -TimeoutSec 3
        $ok = $page.Content -match 'login-assets/globe.js'
    } catch {}
}
Step '把本机控制台快捷方式换成独立窗口（Chrome/Edge 应用模式）'
# 先 Chrome 后 Edge：保存的登录信息一般在平时用的浏览器里
$browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$icon = "$browser"
$newIco = Join-Path $appDir 'dist\public\login-assets\favicon.ico'
if (Test-Path $newIco) { Copy-Item $newIco (Join-Path $root 'tianxi.ico') -Force; $icon = Join-Path $root 'tianxi.ico' }
if ($browser) {
    $shell = New-Object -ComObject WScript.Shell
    $dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\手机远控'))
    foreach ($dir in $dirs) {
        foreach ($name in '打开本机控制台', '管理后台') {
            $url = Join-Path $dir "$name.url"
            $lnk = Join-Path $dir "$name.lnk"
            if (-not (Test-Path $url) -and -not (Test-Path $lnk)) { continue }
            $sc = $shell.CreateShortcut($lnk)
            $sc.TargetPath = $browser
            $sc.Arguments = "--app=http://127.0.0.1:$port/admin-login"
            $sc.IconLocation = "$icon,0"
            $sc.Description = '手机远控本机控制台'
            $sc.Save()
            Remove-Item $url -ErrorAction SilentlyContinue
            Write-Host "已更新：$lnk"
        }
    }
} else { Write-Host '没找到 Edge 或 Chrome，快捷方式保持不变。' }

if ($ok) {
    Write-Host "`n更新完成：http://127.0.0.1:$port/admin-login 已是新登录页。" -ForegroundColor Green
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "`n服务没有在 60 秒内用新页面响应。回滚方法：删除 $appDir\dist，把 $backup 改名回 dist，再运行 schtasks /Run /TN PhoneRemote-Node。日志：$root\logs\node.log" -ForegroundColor Yellow
}
