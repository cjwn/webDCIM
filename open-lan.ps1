# 为 OUTPUTWebViewer 开放局域网访问（自动申请管理员权限）
# 由 开放局域网.bat 调用；也可以右键"使用 PowerShell 运行"

param([switch]$NoElevate)
if ($env:NOELEVATE -eq '1') { $NoElevate = $true }   # 供无 UAC 环境/自动化测试用

$port = 7788
$portFile = Join-Path $PSScriptRoot 'cache\port.txt'
if (Test-Path $portFile) {
    $h = (Get-Content $portFile -Raw).Trim()
    if ($h -match '^\d+$') { $port = [int]$h }
}

# 是否以管理员身份运行
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $NoElevate) {
    Write-Host '需要管理员权限，正在申请 UAC 授权……' -ForegroundColor Yellow
    $exe = (Get-Process -Id $PID).Path
    try {
        Start-Process -Verb RunAs -FilePath $exe -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"')
        )
    } catch {
        Write-Host ('提权失败: ' + $_.Exception.Message) -ForegroundColor Red
        Read-Host '按回车关闭'
    }
    exit
}

$ruleName = "OUTPUTWebViewer $port"
Write-Host "正在为 TCP $port 添加防火墙入站放行规则……"

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $port -Profile Private, Domain -ErrorAction Stop | Out-Null
    # 双重确认：非终止错误不会进 catch，所以实际查一遍
    $created = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($created) {
        Write-Host "[OK] 已放行 TCP $port（仅专用网络 / 域网络）" -ForegroundColor Green
    } else {
        Write-Host '[失败] 规则没有创建成功。' -ForegroundColor Red
    }
} catch {
    Write-Host ('[失败] ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '       请右键「开放局域网.bat」→ 以管理员身份运行。' -ForegroundColor DarkGray
}

# 如果是公用网络，上面的规则不会生效，问一下要不要改成专用
$publicProfiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.NetworkCategory -eq 'Public' }
if ($publicProfiles) {
    Write-Host ''
    $publicProfiles | ForEach-Object {
        Write-Host ('[注意] 当前网络是"公用网络"，上面的规则不会生效: ' + $_.Name) -ForegroundColor Yellow
    }
    $ans = Read-Host '要现在把它改成"专用网络"吗? (Y/N)'
    if ($ans -match '^[Yy]') {
        try {
            $publicProfiles | Set-NetConnectionProfile -NetworkCategory Private
            Write-Host '  已切换为专用网络' -ForegroundColor Green
        } catch {
            Write-Host ('  切换失败: ' + $_.Exception.Message) -ForegroundColor Red
        }
    }
}

Write-Host ''
Write-Host '局域网地址（手机 / 别的电脑用这个；前提是已启动 start.bat）:'
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Where-Object { $_.InterfaceAlias -notmatch 'VMware|VirtualBox|vEthernet|Loopback|WSL|Tailscale|ZeroTier' } |
    ForEach-Object {
        Write-Host ('  http://' + $_.IPAddress + ':' + $port + '   (' + $_.InterfaceAlias + ')')
    }
Write-Host ''
if (-not $NoElevate) { Read-Host '按回车关闭' }
