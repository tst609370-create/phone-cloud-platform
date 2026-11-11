# 把本机已安装的“手机远程控制”（%LOCALAPPDATA%\PhoneRemote）更新到 GitHub main 的最新代码。
# 只换 app\dist（前端页面 + 服务端打包），不动配置、账号、租用数据、FRP；旧 dist 会备份。
# 用法（PowerShell）：irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/update-local-windows.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
$ver = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
$zip = Join-Path $work 'node.zip'
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $work
Rename-Item (Join-Path $work "node-$ver-win-x64") $nodeDir
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
schtasks /End /TN 'PhoneRemote-Node' 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $nodeExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
$backup = Join-Path $appDir ("dist.bak-" + (Get-Date -Format 'yyyyMMddHHmmss'))
Move-Item (Join-Path $appDir 'dist') $backup
Copy-Item $newDist (Join-Path $appDir 'dist') -Recurse
Write-Host "旧版本备份在：$backup"

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
if ($ok) {
    Write-Host "`n更新完成：http://127.0.0.1:$port/admin-login 已是新登录页。" -ForegroundColor Green
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "`n服务没有在 60 秒内用新页面响应。回滚方法：删除 $appDir\dist，把 $backup 改名回 dist，再运行 schtasks /Run /TN PhoneRemote-Node。日志：$root\logs\node.log" -ForegroundColor Yellow
}
