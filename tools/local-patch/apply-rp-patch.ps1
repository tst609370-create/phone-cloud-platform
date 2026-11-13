# 给本机已装的手机控制台打补丁，不替换程序（保住本机独有功能，如「微信数据」）：
#   1) 侧栏加「添加模拟器 / 云手机」（填 IP:端口 或扫描本机模拟器，控制台开着时每 20 秒自动重连）
#   2) 每台手机窗口的按钮挂到画面右侧竖排
# 只往 app\dist\public 放一个 rp-patch.js，并在 index.html 末尾加一行 <script>；原 index.html 备份为 index.html.bak-rp
# 用法（PowerShell 5.1）：irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/local-patch/apply-rp-patch.ps1 | iex
# 撤销：把 index.html.bak-rp 改回 index.html
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$runCmd = Join-Path $env:LOCALAPPDATA 'PhoneRemote\run-node.cmd'
if (-not (Test-Path $runCmd)) { throw "没找到 $runCmd ，这台电脑上好像没装手机远程控制。" }
$appDir = [regex]::Match((Get-Content $runCmd -Raw), 'cd /d "([^"]+)"').Groups[1].Value
$pub = Join-Path $appDir 'dist\public'
$index = Join-Path $pub 'index.html'
if (-not (Test-Path $index)) { throw "没找到 $index" }
$ref = if ($env:PR_REF) { $env:PR_REF } else { 'main' }
$path = 'tools/local-patch/rp-patch.js'
$urls = @("https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/$ref/$path",
    "https://ghfast.top/https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/$ref/$path",
    "http://81.71.94.90:8099/tools/rp-patch.js")
$js = $null
foreach ($u in $urls) {
    try { $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 60; $js = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()); if ($js -match '__remoteDevicesPatch') { break } else { $js = $null } }
    catch { Write-Host "  $u 失败：$($_.Exception.Message)" -ForegroundColor Yellow }
}
if (-not $js) { throw '补丁文件下载失败' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $pub 'rp-patch.js'), $js, $utf8)
$html = [IO.File]::ReadAllText($index, [Text.Encoding]::UTF8)
if (-not (Test-Path "$index.bak-rp")) { [IO.File]::WriteAllText("$index.bak-rp", $html, $utf8) }
$html = [regex]::Replace($html, '\s*<script src="rp-patch\.js[^"]*"></script>', '')
$tag = '<script src="rp-patch.js?v=' + (Get-Date -Format 'yyyyMMddHHmmss') + '"></script>'
$html = $html -replace '</body>', "    $tag`r`n</body>"
[IO.File]::WriteAllText($index, $html, $utf8)
Write-Host "已打补丁：$pub\rp-patch.js" -ForegroundColor Green
Write-Host '关掉控制台窗口重新打开（或按 Ctrl+F5）即可：侧栏下方有「添加模拟器 / 云手机」，手机窗口按钮在右侧。' -ForegroundColor Green
