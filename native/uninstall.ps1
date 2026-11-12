# 卸载显卡切换辅助程序：移除原生消息清单与注册表项，并可选择恢复显卡偏好。
# 用法：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

$ErrorActionPreference = 'Stop'
$hostName = 'com.we.newtab.gpu'
$targetDir = Join-Path $env:LOCALAPPDATA 'WeNewTab'

$roots = @(
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)

foreach ($root in $roots) {
  $path = "$root\$hostName"
  if (Test-Path $path) {
    Remove-Item -Path $path -Recurse -Force
    Write-Host "已移除注册表项：$path"
  }
}

if (Test-Path $targetDir) {
  Remove-Item -Path $targetDir -Recurse -Force
  Write-Host "已删除：$targetDir"
}

Write-Host ''
Write-Host '卸载完成。显卡偏好仍保留在系统中；如需恢复为「由 Windows 决定」，运行：' -ForegroundColor Yellow
Write-Host '  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\DirectX\UserGpuPreferences" -Name "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"'
