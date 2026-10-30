@echo off
chcp 65001 >nul
setlocal
set "TARGET=%~dp0"
if not exist "%TARGET%install-state.json" set "TARGET=%LOCALAPPDATA%\WeChatFish"
echo 请在弹出的微信窗口里扫码登录
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Get-Process Weixin,WeChat -ErrorAction SilentlyContinue)) { & '%TARGET%\start-wechat.ps1' }"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\bootstrap-account.ps1" -TargetDir "%TARGET%"
if errorlevel 1 (
 echo 首次登录未完成，请确认微信登录后重新双击此文件。
 pause
 exit /b 1
)
start "" /D "%TARGET%\app\console" "%TARGET%\app\console\wechat-fish-console.exe"
endlocal
