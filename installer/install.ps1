param([string]$TargetDir="$env:LOCALAPPDATA\WeChatFish",[int]$Port=30001,[int]$AdapterPort=8766,[int]$ReaderPort=5031,[int]$BridgePort=11232,[string]$TaskSuffix='',[switch]$BootstrapAccount)
$ErrorActionPreference='Stop'
function JsonFile($p,$o){[IO.File]::WriteAllText($p,($o|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))}
try {
 if($TaskSuffix -notmatch '^[A-Za-z0-9_-]*$'){throw 'E_SUFFIX: 任务后缀只能是字母数字'}
 $TargetDir=[IO.Path]::GetFullPath($TargetDir).TrimEnd('\'); $payload=Join-Path $PSScriptRoot 'payload'
 Write-Host '正在校验载荷和安装目录……'
 foreach($f in @('client\Weixin.exe','hook\version.dll','hook\build.json','runtime\node.exe','runtime\python\python.exe','app\bridge\main.js','app\console\wechat-fish-console.exe','app\template\scripts\reader-api.py')){if(!(Test-Path "$payload\$f")){throw "E_PAYLOAD: 缺少 $f"}}
 if(Test-Path $TargetDir){throw 'E_TARGET_EXISTS: 请使用空目录，避免覆盖现有数据'}
 foreach($name in @("WeChatFishReader$TaskSuffix","WeChatFishBridge$TaskSuffix")){if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw "E_TASK_EXISTS: 任务已存在 $name"}}
 New-Item -ItemType Directory $TargetDir|Out-Null
 JsonFile "$TargetDir\install-state.json" @{target=$TargetDir;taskSuffix=$TaskSuffix;version='0.2.0';hookPort=$Port;readerPort=$ReaderPort;bridgePort=$BridgePort;adapterPort=$AdapterPort}
 Write-Host '正在复制客户端和运行时……'
 Copy-Item "$payload\*" $TargetDir -Recurse -Force
 Copy-Item "$TargetDir\app\template" "$TargetDir\workspace" -Recurse
 New-Item -ItemType Directory -Force "$TargetDir\workspace\state\hook","$TargetDir\logs"|Out-Null
 $bytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose();$token=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
 foreach($f in @('workspace\state\hook\native-token.txt','client\wechatagent-hook.token')){[IO.File]::WriteAllText("$TargetDir\$f",$token)}
 Copy-Item "$TargetDir\hook\version.dll" "$TargetDir\client\version.dll" -Force
 $c=Get-Content "$TargetDir\workspace\config\wechatagent.json" -Raw|ConvertFrom-Json
 $c.runtime.python="$TargetDir\runtime\python\python.exe";$c.hook.baseUrl="http://127.0.0.1:$Port";$c.hook.wechatExecutable="$TargetDir\client\Weixin.exe";$c.ports.weflow=$ReaderPort;$c.ports.adapter=$AdapterPort
 JsonFile "$TargetDir\workspace\config\wechatagent.json" $c
 JsonFile "$TargetDir\workspace\state\wechat-io-config.json" @{reader_base_url="http://127.0.0.1:$ReaderPort";reader_token=$token;hook_base_url="http://127.0.0.1:$Port";bridge_base_url="http://127.0.0.1:$BridgePort";hook_port=$Port;reader_port=$ReaderPort;bridge_port=$BridgePort;self_wxid='';onebot_ws_url='ws://127.0.0.1:11229/ws'}
 JsonFile "$TargetDir\app\bridge\config.json" @{ownWxid='';admins=@();whitelist=@();mentionAliases=@();reader=@{baseUrl="http://127.0.0.1:$ReaderPort";token=$token};hook=@{baseUrl="http://127.0.0.1:$Port";token=$token};fish=@{baseUrl='http://127.0.0.1:11231';token=$token;timeoutMs=30000};statusPort=$BridgePort;pacing=@{baseMs=4000;jitter=@(0.6,1.2);maxPerMinute=8};batch=@{silenceMs=2200;groupSilenceMs=6000;maxRows=40};sender=@{pollMs=400;receiptTimeoutMs=18000};paths=@{wechatAgentHome='';memePacks='';outgoingStickers=''}}
 # Empty whitelist means silence; the distributed copy permits this safe first-run state.
 $entry="$TargetDir\app\bridge\main.js";$text=[IO.File]::ReadAllText($entry);$text=$text.Replace('!Array.isArray(config.whitelist) || !config.whitelist.length','!Array.isArray(config.whitelist)');[IO.File]::WriteAllText($entry,$text)
 # 把同一枚令牌写进 DSH 插件配置，否则插件与桥接对不上，装完她不会说话
 $dshCfg=Join-Path $env:USERPROFILE '.dsh-fish\config.json'
 if(Test-Path $dshCfg){
  try{
   Copy-Item $dshCfg "$dshCfg.bak-wechatfish" -Force
   $j=Get-Content $dshCfg -Raw -Encoding UTF8|ConvertFrom-Json
   if(-not $j.wechat){$j|Add-Member -NotePropertyName wechat -NotePropertyValue ([pscustomobject]@{}) -Force}
   $j.wechat|Add-Member -NotePropertyName token -NotePropertyValue $token -Force
   $j.wechat|Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
   $j.wechat|Add-Member -NotePropertyName maxReplyChars -NotePropertyValue 300 -Force
   $j.wechat|Add-Member -NotePropertyName groupPerHour -NotePropertyValue 4 -Force
   $j.wechat|Add-Member -NotePropertyName groupGapMin -NotePropertyValue 10 -Force
   JsonFile $dshCfg $j
   Write-Host '已把 DSH 插件令牌同步为本次安装的令牌（原配置备份为 config.json.bak-wechatfish）'
  }catch{Write-Host ('警告：无法自动同步 DSH 插件令牌，请手动填入：'+$token)}
 }else{
  Write-Host ('安装完成。请在 DSH 插件「微信」设置里填入令牌：'+$token)
 }
 Write-Host '正在锁定客户端，防止自动更新……'
 $acl=Get-Acl "$TargetDir\client"; JsonFile "$TargetDir\client-acl.json" @{sddl=$acl.Sddl}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,([Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles'),([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),([Security.AccessControl.PropagationFlags]::None),([Security.AccessControl.AccessControlType]::Deny))
 $acl.AddAccessRule($rule);Set-Acl "$TargetDir\client" $acl
 Copy-Item "$PSScriptRoot\start-wechat.ps1" $TargetDir
 Copy-Item "$PSScriptRoot\uninstall.ps1" $TargetDir
 Copy-Item "$PSScriptRoot\bootstrap-account.ps1","$PSScriptRoot\first-run.cmd" $TargetDir
 if(Test-Path "$PSScriptRoot\DEPLOY.md"){Copy-Item "$PSScriptRoot\DEPLOY.md" $TargetDir}
 foreach($kind in @('reader','bridge')){
  $exe=if($kind -eq 'reader'){"$TargetDir\runtime\python\python.exe"}else{"$TargetDir\runtime\node.exe"}
  $arg=if($kind -eq 'reader'){"`"$TargetDir\workspace\scripts\reader-api.py`""}else{"`"$TargetDir\app\bridge\main.js`" `"$TargetDir\app\bridge\config.json`""}
  $cmd="`"$exe`" $arg"; $escaped=$cmd.Replace('"','""')
  @('Set sh = CreateObject("WScript.Shell")',('sh.Environment("PROCESS")("WECHATAGENT_HOME") = "'+$TargetDir+'\workspace"'),('sh.CurrentDirectory = "'+$TargetDir+'"'),('sh.Run "'+$escaped+'", 0, False'))|Set-Content "$TargetDir\start-$kind.vbs" -Encoding Unicode
  $action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$TargetDir\start-$kind.vbs`""
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName ("WeChatFish"+(Get-Culture).TextInfo.ToTitleCase($kind)+$TaskSuffix) -Action $action -Trigger $trigger -Principal $principal|Out-Null
 }
 $shell=New-Object -ComObject WScript.Shell;$shortcut=$shell.CreateShortcut(([Environment]::GetFolderPath('Desktop')+"\微信薄桥接$TaskSuffix.lnk"));$shortcut.TargetPath="$TargetDir\app\console\wechat-fish-console.exe";$shortcut.WorkingDirectory="$TargetDir\app\console";$shortcut.Save()
 Write-Host '正在执行隔离自检……'
 $results=@();foreach($item in @(@{name='hook';port=$Port},@{name='reader';port=$ReaderPort},@{name='bridge';port=$BridgePort})){
  $existing=Get-NetTCPConnection -State Listen -LocalPort $item.port -ErrorAction SilentlyContinue
  if($existing){$results+=@{component=$item.name;port=$item.port;ready=$false;code='E_PORT_IN_USE';existingPids=@($existing.OwningProcess)};continue}
  if($item.name -eq 'hook'){& "$TargetDir\start-wechat.ps1" -Port $Port -AdapterPort $AdapterPort|Out-Host}else{Start-ScheduledTask -TaskName ("WeChatFish"+(Get-Culture).TextInfo.ToTitleCase($item.name)+$TaskSuffix)}
  $ready=$false;for($i=0;$i -lt 8;$i++){Start-Sleep -Seconds 1;if(Get-NetTCPConnection -State Listen -LocalPort $item.port -ErrorAction SilentlyContinue){$ready=$true;break}}
  $results+=@{component=$item.name;port=$item.port;ready=$ready;code=$(if($ready){'OK'}elseif($item.name -in @('hook','reader')){'E_WECHAT_NOT_RUNNING'}else{'E_NOT_LISTENING'})}
 }
 $report=@{installed=$true;target=$TargetDir;taskSuffix=$TaskSuffix;checks=$results;allReady=(@($results|Where-Object {!$_.ready}).Count -eq 0)}
 JsonFile "$TargetDir\self-test.json" $report; $report|ConvertTo-Json -Depth 12
 if($BootstrapAccount){
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TargetDir\bootstrap-account.ps1" -TargetDir $TargetDir; if($LASTEXITCODE -ne 0){Write-Warning '安装成功，首次登录未完成。请双击安装目录中的 first-run.cmd。'} }
  catch {Write-Warning '安装成功，首次登录未完成。请双击安装目录中的 first-run.cmd。'}
 }else{Write-Host '安装成功。首次使用请双击安装目录中的 first-run.cmd 完成扫码引导。'}
} catch {Write-Error ("安装失败："+$_.Exception.Message);exit 1}
