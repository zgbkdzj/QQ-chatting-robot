# DSH + QQ + SnowLuma + QQ桥接 + SoVITS语音 一键启动 v2.4
#
# v2.4 更新（2026-10-10）：
#   - 新增 [5/5] SoVITS 语音服务 + 守护进程（watch-sovits.mjs）
#     背景：SoVITS 挂掉会让机器人"变哑巴"且不报错，已发生多次。
#   - 修正底部模型提示（原写着 Our Free Model/MiMo，实际早已改为
#     dsh-model-gateway/DeepSeek-V4.1-Flash，由 owner 在控制台设置）
#   - Test-Port 改用 TcpClient（原 netstat 字符串匹配不够可靠）
#   - 统一步骤编号 [1/5]~[5/5]
#
# v2.2: 加入桌面版 QQ 自动启动（SnowLuma 注入的目标）。
# 现有防回归：桥接代码新鲜度检测（旧进程跑新代码自动杀旧重拉）、
# DSH 仅插件 JS 代码变更才提示重启（配置改动 HMR 热生效不误报）。
$ErrorActionPreference = 'SilentlyContinue'
$root = '<桥接安装目录>'
$dshExe = 'D:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
$qqExe = 'D:\Program Files (x86)\Tencent\QQNT\QQ.exe'
$snowDir = 'C:\SnowLuma'
$sovitsDir = Join-Path $root 'SoVITS'
$watchMjs = Join-Path $sovitsDir 'watch-sovits.mjs'
$profileNm = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'

function Test-Port([int]$port) {
  # TcpClient 比 netstat 文本解析可靠（netstat 在多网卡/长输出下易误判）
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
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
# WMI 拉起：普通 Start-Process 的子进程可能被作业对象回收，服务类进程要用 WMI
function Start-Detached([string]$commandLine, [string]$workDir) {
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
    -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $workDir }
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '    DSH + QQ + SnowLuma + 桥接 + 语音 一键启动 v2.4' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''

# [1/5] 桌面版 QQ —— 只认新版 QQNT（注入目标），不认老版 Tencent\QQ\Bin
$qq = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $qqExe) } | Select-Object -First 1
if ($qq) {
  Write-Host '  [1/5] 新版 QQ (QQNT) ......... 已在运行' -ForegroundColor Green
} else {
  $legacy = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\Tencent\QQ\Bin\*') } | Select-Object -First 1
  if ($legacy) {
    Write-Host '  [1/5] 检测到的是老版 QQ（Tencent\QQ\Bin），不计入检测；启动新版 QQNT...' -ForegroundColor Yellow
  } else {
    Write-Host '  [1/5] 启动新版 QQ（QQNT；若开了自动登录会自行登入，否则需扫码一次）...' -ForegroundColor Cyan
  }
  Start-Process -FilePath $qqExe
}

# [2/5] DeepSeek Harness 桌面版
$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dsh) {
  Write-Host '  [2/5] DSH 桌面版 ............. 已在运行' -ForegroundColor Green
  $staleJs = Get-ChildItem $profileNm -Recurse -Filter '*.js' -Depth 4 -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $dsh.StartTime } | Select-Object -First 1
  if ($staleJs) {
    Write-Host "  [2/5] ! 插件代码有改动晚于 DSH 启动（$($staleJs.Name)），需重启加载：" -ForegroundColor Yellow
    $ans = Read-Host '        完全重启 DSH？(y/N)'
    if ($ans -match '^[Yy]') {
      Stop-Process -Name 'DeepSeek Harness' -Force
      Start-Sleep -Seconds 3
      Start-Process -FilePath $dshExe
      Write-Host '  [2/5] 已重启 DSH' -ForegroundColor Yellow
      Write-Host '        ! 注意：重启 DSH 会连带挂掉桥接与 SoVITS，脚本末尾会重新拉起' -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '  [2/5] 启动 DSH 桌面版...' -ForegroundColor Cyan
  Start-Process -FilePath $dshExe
}

# [3/5] SnowLuma（hookAutoLoad 已开启：发现 QQ 即自动注入）
if (Test-Port 5099) {
  Write-Host '  [3/5] SnowLuma ............... 已在运行' -ForegroundColor Green
} else {
  Write-Host '  [3/5] 启动 SnowLuma（会自动注入正在运行的 QQ）...' -ForegroundColor Cyan
  Start-Detached "cmd /c `"$snowDir\启动SnowLuma.bat`"" $snowDir | Out-Null
}

# [4/5] QQ 桥接（代码新鲜度检查）
$bridgeFiles = @("$root\src\bridge.js", "$root\src\dsh-client.js", "$root\config.json")
$newest = ($bridgeFiles | ForEach-Object { (Get-Item $_).LastWriteTime } | Sort-Object -Descending) | Select-Object -First 1
$bp = Get-BridgeProcess
if (-not $bp) {
  Write-Host '  [4/5] 启动 QQ 桥接（守护模式）...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\start.bat`"" -WorkingDirectory $root -WindowStyle Minimized
} elseif ($newest -gt [DateTime]$bp.Start) {
  Write-Host "  [4/5] ! 桥接代码/配置比进程新（$($newest.ToString('HH:mm:ss')) > $($bp.Start.ToString('HH:mm:ss'))），重启加载修复..." -ForegroundColor Yellow
  Restart-Bridge
  Write-Host '  [4/5] 桥接已用最新代码重启' -ForegroundColor Green
} else {
  Write-Host '  [4/5] QQ 桥接 ................ 已在运行（代码已是最新）' -ForegroundColor Green
}

# [5/5] SoVITS 语音服务 + 守护
# 语音引擎挂掉 = 机器人变哑巴且无告警，所以除了拉起服务，还要拉起守护。
if (-not (Test-Path $watchMjs)) {
  Write-Host "  [5/5] ! 找不到守护脚本 $watchMjs，跳过语音" -ForegroundColor Yellow
} else {
  $node = 'D:\Program Files\nodejs\node.exe'
  if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  # 守护进程检测：命令行里含 watch-sovits
  $watcher = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'watch-sovits' } | Select-Object -First 1
  if ($watcher) {
    Write-Host '  [5/5] 语音守护 ............... 已在运行' -ForegroundColor Green
  } else {
    Write-Host '  [5/5] 启动语音守护（会自动拉起 SoVITS）...' -ForegroundColor Cyan
    if ($node) {
      Start-Detached "`"$node`" `"$watchMjs`"" $sovitsDir | Out-Null
    } else {
      Write-Host '        ! 找不到 node.exe，无法启动语音守护' -ForegroundColor Yellow
    }
  }
  # 守护首次探活要等 15s，这里不阻塞等待，仅提示
  if (Test-Port 9880) {
    Write-Host '        SoVITS 服务 ............ 9880 已就绪' -ForegroundColor Green
  } else {
    Write-Host '        SoVITS 服务 ............ 守护将在约 15 秒内拉起（权重加载约需 60~90 秒）' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '  启动完成，各入口：' -ForegroundColor Cyan
Write-Host '    DSH 客户端 ....... 桌面应用窗口'
Write-Host '    SnowLuma 管理页 .. http://127.0.0.1:5099（自动注入 QQ，无需手动）'
Write-Host '    桥接控制台 ...... http://127.0.0.1:3100'
Write-Host '    语音引擎 ........ http://127.0.0.1:9880（守护：watch-sovits.mjs）'
Write-Host '    白名单 .......... 见 config.json 的 allow.groups / allow.private'
$modelLine = 'unknown'
try {
  $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $modelLine = "$($cfg.dsh.provider) / $($cfg.dsh.model)"
} catch {}
Write-Host "    模型 ............ $modelLine（读取自 config.json，以控制台设置为准）"
Write-Host ''
Read-Host '按回车关闭本窗口'
