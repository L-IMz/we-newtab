# 安装 WE 新标签页的显卡切换辅助程序（原生消息宿主）。
# 作用：让扩展能够读写浏览器的显卡偏好（独显 / 核显），普通网页 API 没有这个权限。
# 用法：在此文件所在目录执行
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $scriptDir 'WeGpuHost.cs'
$targetDir = Join-Path $env:LOCALAPPDATA 'WeNewTab'
$hostName = 'com.we.newtab.gpu'
$extensionId = 'apcpajapcfggfkdognohofplpeagigep'

if (-not (Test-Path $source)) {
  Write-Error "找不到 WeGpuHost.cs（应与本脚本同目录）：$source"
  exit 1
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$exePath = Join-Path $targetDir 'WeGpuHost.exe'

$csc = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe',
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
  Write-Error '未找到 .NET Framework 编译器 csc.exe，无法编译辅助程序。'
  exit 1
}

& $csc /nologo /target:exe /out:"$exePath" /r:System.Web.Extensions.dll "$source"
if (-not (Test-Path $exePath)) {
  Write-Error '编译失败。'
  exit 1
}

$manifestPath = Join-Path $targetDir 'com.we.newtab.gpu.json'
$manifest = [ordered]@{
  name            = $hostName
  description     = 'WE 新标签页 - 浏览器显卡偏好切换'
  path            = $exePath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

$roots = @(
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)

foreach ($root in $roots) {
  New-Item -Path "$root\$hostName" -Force | Out-Null
  Set-ItemProperty -Path "$root\$hostName" -Name '(default)' -Value $manifestPath
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "  宿主程序：$exePath"
Write-Host "  清单文件：$manifestPath"
Write-Host '  已注册：Edge / Chrome / Brave / Chromium'
Write-Host ''
Write-Host '回到扩展的「显卡」面板刷新即可看到当前偏好。'
