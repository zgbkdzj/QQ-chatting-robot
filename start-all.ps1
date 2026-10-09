# DSH + QQ + SnowLuma + QQ桥接 一键启动 v2.3
# v2.2: 加入桌面版 QQ 自动启动（SnowLuma 注入的目标）。
# 现有防回归：桥接代码新鲜度检测（旧进程跑新代码自动杀旧重拉）、
# DSH 仅插件 JS 代码变更才提示重启（配置改动 HMR 热生效不误报）。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Program Files (x86)\qq-bridge'
$dshExe = 'D:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
$qqExe = 'D:\Program Files (x86)\Tencent\QQNT\QQ.exe'
$snowDir = 'C:\SnowLuma'
$profileNm = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'

function Test-Port([int]$port) {
  (netstat -ano | Select-String (':' + $port + ' ') | Select-String 'LISTENING') -ne $null
}
function Get-BridgeProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
    ForEach-Object { [pscustomobject]@{ Pid = $_.ProcessId; Start = $_.CreationDate } } |
    Select-Object -First 1
}
function Restart-Bridge {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*qq-bridge*start.bat*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\start.bat`"" -WorkingDirectory $root
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '    DSH + QQ + SnowLuma + QQ 桥接 一键启动 v2.3' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''

# [1/4] 桌面版 QQ —— 只认新版 QQNT（注入目标），不认老版 Tencent\QQ\Bin
$qq = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $qqExe) } | Select-Object -First 1
if ($qq) {
  Write-Host '  [1/4] 新版 QQ (QQNT) ......... 已在运行' -ForegroundColor Green
} else {
  $legacy = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\Tencent\QQ\Bin\*') } | Select-Object -First 1
  if ($legacy) {
    Write-Host '  [1/4] 检测到的是老版 QQ（Tencent\QQ\Bin），不计入检测；启动新版 QQNT...' -ForegroundColor Yellow
  } else {
    Write-Host '  [1/4] 启动新版 QQ（QQNT；若开了自动登录会自行登入，否则需扫码一次）...' -ForegroundColor Cyan
  }
  Start-Process -FilePath $qqExe
}

# [2/4] DeepSeek Harness 桌面版
$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dsh) {
  Write-Host '  [2/4] DSH 桌面版 ............. 已在运行' -ForegroundColor Green
  $staleJs = Get-ChildItem $profileNm -Recurse -Filter '*.js' -Depth 4 -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $dsh.StartTime } | Select-Object -First 1
  if ($staleJs) {
    Write-Host "  [2/4] ! 插件代码有改动晚于 DSH 启动（$($staleJs.Name)），需重启加载：" -ForegroundColor Yellow
    $ans = Read-Host '        完全重启 DSH？(y/N)'
    if ($ans -match '^[Yy]') {
      Stop-Process -Name 'DeepSeek Harness' -Force
      Start-Sleep -Seconds 3
      Start-Process -FilePath $dshExe
      Write-Host '  [2/4] 已重启 DSH' -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '  [2/4] 启动 DSH 桌面版...' -ForegroundColor Cyan
  Start-Process -FilePath $dshExe
}

# [3/4] SnowLuma（hookAutoLoad 已开启：发现 QQ 即自动注入）
if (Test-Port 5099) {
  Write-Host '  [3/4] SnowLuma ............... 已在运行' -ForegroundColor Green
} else {
  Write-Host '  [3/4] 启动 SnowLuma（会自动注入正在运行的 QQ）...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$snowDir\启动SnowLuma.bat`"" -WindowStyle Minimized
}

# [4/4] QQ 桥接（代码新鲜度检查）
$bridgeFiles = @("$root\src\bridge.js", "$root\src\dsh-client.js", "$root\config.json")
$newest = ($bridgeFiles | ForEach-Object { (Get-Item $_).LastWriteTime } | Sort-Object -Descending) | Select-Object -First 1
$bp = Get-BridgeProcess
if (-not $bp) {
  Write-Host '  [4/4] 启动 QQ 桥接（守护模式）...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\start.bat`"" -WorkingDirectory $root -WindowStyle Minimized
} elseif ($newest -gt [DateTime]$bp.Start) {
  Write-Host "  [4/4] ! 桥接代码/配置比进程新（$($newest.ToString('HH:mm:ss')) > $($bp.Start.ToString('HH:mm:ss'))），重启加载修复..." -ForegroundColor Yellow
  Restart-Bridge
  Write-Host '  [4/4] 桥接已用最新代码重启' -ForegroundColor Green
} else {
  Write-Host '  [4/4] QQ 桥接 ................ 已在运行（代码已是最新）' -ForegroundColor Green
}

Write-Host ''
Write-Host '  启动完成，各入口：' -ForegroundColor Cyan
Write-Host '    DSH 客户端 ....... 桌面应用窗口'
Write-Host '    SnowLuma 管理页 .. http://127.0.0.1:5099（自动注入 QQ，无需手动）'
Write-Host '    桥接控制台 ...... http://127.0.0.1:3100'
Write-Host '    白名单 .......... 见 config.json 的 allow.groups / allow.private'
Write-Host '    模型 ............ Our Free Model · MiMo V2.6 Flash (Deep)'
Write-Host ''
Read-Host '按回车关闭本窗口'