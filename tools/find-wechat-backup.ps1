# 找回被更新覆盖掉的本机功能（如「微信数据」）：
# update-local-windows.ps1 每次更新都把旧 app\dist 改名为 dist.bak-<时间>。本脚本在这些备份里找含微信相关代码的版本，
# 打包到桌面 PhoneRemote-wechat-backup.zip（发给 Claude 合进 main），并默认把它换回当前运行版本（当前版本另存为 dist.bak-<时间>-replaced，可回滚）。
# 只查不换：先设 $env:NO_RESTORE='1'
# 用法（PowerShell 5.1）：irm https://raw.githubusercontent.com/tst609370-create/phone-cloud-platform/main/tools/find-wechat-backup.ps1 | iex
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'PhoneRemote'
$runCmd = Join-Path $root 'run-node.cmd'
if (-not (Test-Path $runCmd)) { throw "没找到 $runCmd" }
$text = Get-Content $runCmd -Raw
$appDir = [regex]::Match($text, 'cd /d "([^"]+)"').Groups[1].Value
$nodeExe = [regex]::Match($text, '"([^"]+node\.exe)"').Groups[1].Value
Write-Host "app 目录：$appDir"

$pattern = 'wechat|wxid|weixin|微信数据|微信号|聊天记录'
$dirs = @(Get-ChildItem $appDir -Directory | Where-Object { $_.Name -like 'dist*' } | Sort-Object LastWriteTime -Descending)
if (-not $dirs) { throw "$appDir 下没有 dist 或 dist.bak-* 目录" }
$hit = $null
foreach ($d in $dirs) {
    $files = @(Get-ChildItem $d.FullName -Recurse -File -Include *.js, *.html, *.css, *.json -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
        Select-String -Pattern $pattern -List -ErrorAction SilentlyContinue)
    $names = ($files | ForEach-Object { $_.Path.Substring($d.FullName.Length + 1) }) -join ', '
    Write-Host ("{0,-34} {1:yyyy-MM-dd HH:mm}  命中 {2} 个文件 {3}" -f $d.Name, $d.LastWriteTime, $files.Count, $names)
    if ($files.Count -gt 0 -and -not $hit -and $d.Name -ne 'dist') { $hit = $d }
}
if (-not $hit) {
    if (@($dirs | Where-Object { $_.Name -eq 'dist' }).Count) { Write-Host "`n备份里没找到微信相关代码。请把上面这几行截图发给 Claude，并说一下这个功能在界面上的入口。" -ForegroundColor Yellow }
    return
}

$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PhoneRemote-wechat-backup.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
$tmp = Join-Path $env:TEMP ("wechat-backup-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $tmp | Out-Null
robocopy $hit.FullName $tmp /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n含微信功能的版本：$($hit.Name)，已打包到桌面 $zip（不含 node_modules），请把这个 zip 发给 Claude。" -ForegroundColor Green

if ($env:NO_RESTORE -eq '1') { return }
$ErrorActionPreference = 'Continue'
schtasks /End /TN 'PhoneRemote-Node' 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $nodeExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
$cur = Join-Path $appDir 'dist'
$saved = Join-Path $appDir ("dist.bak-" + (Get-Date -Format 'yyyyMMddHHmmss') + "-replaced")
Move-Item $cur $saved
Copy-Item $hit.FullName $cur -Recurse
$ErrorActionPreference = 'Continue'
schtasks /Run /TN 'PhoneRemote-Node' 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Write-Host "已换回 $($hit.Name) 并重启服务，微信数据功能应已回来（今天的新改动暂时不在，合进 main 后再更新一次就都有）。" -ForegroundColor Green
Write-Host "要撤回：删除 $cur，把 $saved 改名回 dist，再运行 schtasks /Run /TN PhoneRemote-Node"
