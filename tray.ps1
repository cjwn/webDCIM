param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TrayNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

$script:rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:cacheDir = Join-Path $script:rootDir 'cache'
$script:logFile = Join-Path $script:cacheDir 'server.log'
$script:errLogFile = Join-Path $script:cacheDir 'server-err.log'
$script:pidFile = Join-Path $script:cacheDir 'server.pid'
$script:portFile = Join-Path $script:cacheDir 'port.txt'
$script:psSelf = $MyInvocation.MyCommand.Path
$script:startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'OUTPUTWebViewer.lnk'

$script:port = 7788
if ($env:PORT -match '^\d+$') {
    $script:port = [int]$env:PORT
} elseif (Test-Path $script:portFile) {
    $pTxt = (Get-Content $script:portFile -Raw).Trim()
    if ($pTxt -match '^\d+$') { $script:port = [int]$pTxt }
}
$script:localUrl = "http://localhost:$($script:port)"

# 单实例保护：已有托盘在运行时直接打开网页并退出
$createdNew = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\OUTPUTWebViewer_Tray_Mutex', [ref]$createdNew)
if (-not $createdNew) {
    Start-Process $script:localUrl
    exit 0
}

# 检查 Node.js
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show(
        "未找到 Node.js，请先从 https://nodejs.org/ 安装后再启动。",
        "照片库总览",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}
$script:nodeExe = $nodeCmd.Source
New-Item -ItemType Directory -Path $script:cacheDir -Force | Out-Null

function New-LensIcon {
    param([System.Drawing.Color]$RingColor)
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 27, 36))
    $g.FillEllipse($bgBrush, 1, 1, 30, 30)

    $ringPen = New-Object System.Drawing.Pen($RingColor, 3.2)
    $g.DrawEllipse($ringPen, 4, 4, 24, 24)

    $innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 36, 48, 68))
    $g.FillEllipse($innerBrush, 9, 9, 14, 14)

    $glintBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 220, 240, 255))
    $g.FillEllipse($glintBrush, 12, 11, 5, 5)

    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon).Clone()
    [TrayNative]::DestroyIcon($hIcon) | Out-Null
    $glintBrush.Dispose(); $innerBrush.Dispose(); $ringPen.Dispose(); $bgBrush.Dispose(); $g.Dispose(); $bmp.Dispose()
    return $icon
}

$script:iconRunning = New-LensIcon ([System.Drawing.Color]::FromArgb(255, 77, 159, 255))
$script:iconStopped = New-LensIcon ([System.Drawing.Color]::FromArgb(255, 245, 158, 11))
$script:serverProc = $null
$script:exiting = $false

function Kill-PortListeners {
    param([int]$Port)
    $lines = netstat -ano 2>$null | Select-String ":$Port\s+.*LISTENING\s+(\d+)$"
    $pids = @()
    foreach ($m in $lines) {
        if ($m.Line -match '(\d+)\s*$') {
            $p = [int]$Matches[1]
            if ($p -gt 0 -and $pids -notcontains $p) { $pids += $p }
        }
    }
    foreach ($p in $pids) {
        Start-Process -FilePath 'taskkill.exe' -ArgumentList "/F /T /PID $p" -WindowStyle Hidden -Wait | Out-Null
    }
}

function Stop-PhotoServer {
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        Start-Process -FilePath 'taskkill.exe' -ArgumentList "/F /T /PID $($script:serverProc.Id)" -WindowStyle Hidden -Wait | Out-Null
    }
    $script:serverProc = $null
    if (Test-Path $script:pidFile) {
        $oldPid = (Get-Content $script:pidFile -Raw).Trim()
        if ($oldPid -match '^\d+$') {
            Start-Process -FilePath 'taskkill.exe' -ArgumentList "/F /T /PID $oldPid" -WindowStyle Hidden -Wait | Out-Null
        }
        Remove-Item $script:pidFile -Force -ErrorAction SilentlyContinue
    }
    Kill-PortListeners -Port $script:port
}

function Test-ServerReady {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:port)/api/state" -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-LanUrl {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:port)/api/state" -TimeoutSec 2
        if ($r -and $r.urls -and $r.urls.Count -gt 0) { return [string]$r.urls[0] }
    } catch {}
    $ips = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.Name -notmatch 'vmware|virtualbox|vethernet|loopback|wsl|tap|tun|zerotier|hamachi' } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not $_.Address.ToString().StartsWith('127.') -and -not $_.Address.ToString().StartsWith('169.254.') }
    if ($ips) { return "http://$($ips[0].Address):$($script:port)" }
    return $script:localUrl
}

function Show-Balloon {
    param([string]$Title, [string]$Text, [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info)
    if ($script:tray) {
        $script:tray.BalloonTipTitle = $Title
        $script:tray.BalloonTipText = $Text
        $script:tray.BalloonTipIcon = $Icon
        $script:tray.ShowBalloonTip(2500)
    }
}

function Update-TrayStatus {
    $running = ($script:serverProc -and -not $script:serverProc.HasExited)
    if ($running) {
        $script:tray.Icon = $script:iconRunning
        $script:tray.Text = "照片库总览 - 运行中 (:$($script:port))"
        $script:miStatus.Text = "● 运行中 (PID $($script:serverProc.Id) · :$($script:port))"
    } else {
        $script:tray.Icon = $script:iconStopped
        $script:tray.Text = "照片库总览 - 已停止"
        $script:miStatus.Text = "○ 服务未运行"
    }
}

function Start-PhotoServer {
    param([switch]$Silent)
    Stop-PhotoServer
    $sep = "`r`n======== 启动服务 " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " ========"
    Add-Content -Path $script:logFile -Value $sep -Encoding UTF8
    "" | Set-Content -Path $script:errLogFile -Encoding UTF8

    $script:serverProc = Start-Process -FilePath $script:nodeExe `
        -ArgumentList 'server.js' `
        -WorkingDirectory $script:rootDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $script:logFile `
        -RedirectStandardError $script:errLogFile `
        -PassThru

    $ok = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 200
        if ($script:serverProc.HasExited) { break }
        if (Test-ServerReady) { $ok = $true; break }
    }
    Update-TrayStatus
    if ($ok) {
        if (-not $Silent) {
            Show-Balloon '照片库总览已启动' "访问 $($script:localUrl) · 双击托盘图标打开网页"
        }
        return $true
    } else {
        Show-Balloon '照片库启动失败' '请右键「查看运行日志」排查错误' ([System.Windows.Forms.ToolTipIcon]::Warning)
        return $false
    }
}

function Set-AutoStart {
    param([bool]$Enable)
    if ($Enable) {
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($script:startupLnk)
        $sc.TargetPath = 'powershell.exe'
        $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$($script:psSelf)`""
        $sc.WorkingDirectory = $script:rootDir
        $sc.WindowStyle = 7
        $sc.Description = 'OUTPUTWebViewer 照片库总览托盘服务'
        $sc.Save()
    } else {
        if (Test-Path $script:startupLnk) { Remove-Item $script:startupLnk -Force }
    }
}

# 构建托盘与右键菜单
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = $script:iconStopped
$script:tray.Text = '照片库总览 - 启动中…'
$script:tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$script:miStatus = New-Object System.Windows.Forms.ToolStripMenuItem '○ 正在启动…'
$script:miStatus.Enabled = $false

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem "打开照片库 ($($script:localUrl))"
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.Add_Click({ Start-Process $script:localUrl })

$miCopyLan = New-Object System.Windows.Forms.ToolStripMenuItem '复制局域网访问地址'
$miCopyLan.Add_Click({
    $u = Get-LanUrl
    [System.Windows.Forms.Clipboard]::SetText($u)
    Show-Balloon '已复制局域网地址' $u
})

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem '重启服务'
$miRestart.Add_Click({
    $script:tray.Icon = $script:iconStopped
    $script:tray.Text = '照片库总览 - 正在重启…'
    if (Start-PhotoServer -Silent) {
        Show-Balloon '照片库服务已重启' "最新代码已生效 ($($script:localUrl))"
    }
})

$miLog = New-Object System.Windows.Forms.ToolStripMenuItem '查看运行日志'
$miLog.Add_Click({
    $errSize = if (Test-Path $script:errLogFile) { (Get-Item $script:errLogFile).Length } else { 0 }
    if ($errSize -gt 3) { Start-Process notepad.exe $script:errLogFile }
    elseif (Test-Path $script:logFile) { Start-Process notepad.exe $script:logFile }
})

$miDir = New-Object System.Windows.Forms.ToolStripMenuItem '打开程序目录'
$miDir.Add_Click({ Start-Process explorer.exe $script:rootDir })

$miStartup = New-Object System.Windows.Forms.ToolStripMenuItem '开机自动启动（静默托盘）'
$miStartup.CheckOnClick = $true
$miStartup.Checked = (Test-Path $script:startupLnk)
$miStartup.Add_Click({
    Set-AutoStart -Enable $miStartup.Checked
    if ($miStartup.Checked) { Show-Balloon '已开启开机自启' '下次开机将自动静默常驻右下角托盘' }
    else { Show-Balloon '已关闭开机自启' '已从 Windows 启动项移除' }
})

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem '退出服务'
$miExit.Add_Click({
    $script:exiting = $true
    $timer.Stop()
    Stop-PhotoServer
    $script:tray.Visible = $false
    $script:tray.Dispose()
    $script:iconRunning.Dispose()
    $script:iconStopped.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$menu.Items.AddRange(@(
    $script:miStatus,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $miOpen,
    $miCopyLan,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $miRestart,
    $miLog,
    $miDir,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $miStartup,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $miExit
))
$script:tray.ContextMenuStrip = $menu

$script:tray.Add_DoubleClick({ Start-Process $script:localUrl })

# 定时检查服务状态
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    if (-not $script:exiting) { Update-TrayStatus }
})
$timer.Start()

# 启动 Node 服务
$started = Start-PhotoServer -Silent:$false
if ($started -and $OpenBrowser) {
    Start-Process $script:localUrl
}

[System.Windows.Forms.Application]::Run()

# 兜底释放
if ($script:mutex) {
    try { $script:mutex.ReleaseMutex() } catch {}
    $script:mutex.Dispose()
}
