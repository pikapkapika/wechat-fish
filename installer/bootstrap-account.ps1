param([string]$TargetDir="$env:LOCALAPPDATA\WeChatFish",[ValidateRange(1,3600)][int]$WaitSeconds=180)
$ErrorActionPreference='Stop'
$code='E_KEY_EXTRACTION_FAILED';$readerStarted=$false
try {
 $TargetDir=[IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
 if($TargetDir -like '*\Programs\WeChatAgent*'){throw 'Refusing production WeChatAgent target'}
 $root="$TargetDir\workspace";$config=Get-Content "$root\config\wechatagent.json" -Raw|ConvertFrom-Json
 $io=Get-Content "$root\state\wechat-io-config.json" -Raw|ConvertFrom-Json
 $token=(Get-Content "$root\state\hook\native-token.txt" -Raw).Trim()
 $deadline=(Get-Date).AddSeconds($WaitSeconds);$health=$null
 Write-Host '请先启动微信并扫码登录'
 do {
  $processes=@(Get-Process Weixin,WeChat -ErrorAction SilentlyContinue)
  $code=if(!$processes.Count){'E_WECHAT_NOT_RUNNING'}else{'E_NOT_LOGGED_IN'}
  if($processes.Count){try{$health=Invoke-RestMethod ($config.hook.baseUrl.TrimEnd('/')+'/WeChatAgent/health') -Headers @{Authorization="Bearer $token"} -TimeoutSec 3}catch{$health=$null}}
  if($health -and @($health.databaseAccounts).Count -eq 1){break}
  Start-Sleep -Seconds 1
 }while((Get-Date) -lt $deadline)
 if(!$health -or @($health.databaseAccounts).Count -ne 1){throw 'No unique logged-in database account before timeout'}
 $code='E_KEY_EXTRACTION_FAILED'
 $runtime="$TargetDir\app\weflow";$vendor="$root\components\weflow-cli"
 New-Item -ItemType Directory -Force "$vendor\scripts","$vendor\resources\key\win32\x64"|Out-Null
 Copy-Item "$runtime\scripts\nt_*.py" "$vendor\scripts" -Force
 Copy-Item "$runtime\resources\key\win32\x64\wx_key.dll" "$vendor\resources\key\win32\x64" -Force
 $exe=$config.hook.wechatExecutable
 $result=& "$TargetDir\runtime\python\python.exe" -B -c "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_path(sys.argv.pop(1),run_name='__main__')" "$runtime\scripts" "$runtime\scripts\bootstrap_account.py" --target $TargetDir --account $health.databaseAccounts[0] --executable $exe --timeout $WaitSeconds
 if($LASTEXITCODE -ne 0){throw 'Credential capture failed; DLL may require signing out and scanning again while bootstrap waits'}
 $capture=$result|ConvertFrom-Json
 if(!$capture.success){throw 'Credential capture failed'}
 $code='E_READER_START_FAILED';$port=[int]$config.ports.weflow
 if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'Reader port already occupied; refusing to alter existing reader'}
 $state=Get-Content "$TargetDir\install-state.json" -Raw|ConvertFrom-Json
 $task="WeChatFishReader$($state.taskSuffix)"
 if(!(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)){throw 'Installed reader task missing'}
 Start-ScheduledTask -TaskName $task;$readerStarted=$true
 $ready=$false
 for($i=0;$i -lt 45;$i++){
  Start-Sleep -Seconds 1
  try{$status=Invoke-RestMethod "http://127.0.0.1:$port/api/v1/reader/status" -Headers @{Authorization="Bearer $($io.reader_token)"} -TimeoutSec 2;if($status.success -eq $true){$ready=$true;break}}catch{}
 }
 if(!$ready){throw 'Reader readiness check failed'}
 @{success=$true;code='OK';account=$capture.accountMasked;credentialsProtected=$true;readerPort=$port;readerSuccess=$true;task=$task}|ConvertTo-Json -Compress
}catch{
 if($readerStarted){Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue}
 [Console]::Error.WriteLine($_.Exception.Message)
 @{success=$false;code=$code;readerSuccess=$false}|ConvertTo-Json -Compress
 exit 1
}
