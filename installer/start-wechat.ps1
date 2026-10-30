param([int]$Port=30001,[int]$AdapterPort=8766)
$ErrorActionPreference='Stop'
# Never disturb another logged-in desktop client (WeChat uses global singleton state).
$other=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object {$_.ExecutablePath -ne "$PSScriptRoot\client\Weixin.exe"})
if($other.Count){Write-Warning 'E_OTHER_WECHAT_RUNNING: 请先自行退出其他微信，本脚本不会关闭正式客户端。';return}
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){Write-Warning 'E_PORT_IN_USE: Hook 端口已被占用。';return}
Start-Process -FilePath "$PSScriptRoot\client\Weixin.exe" -ArgumentList "StartPort=$Port CallBackURL=`"http://127.0.0.1:$AdapterPort/unused`"" -WorkingDirectory "$PSScriptRoot\client"
