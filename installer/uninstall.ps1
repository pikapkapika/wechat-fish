param([string]$TargetDir="$env:LOCALAPPDATA\WeChatFish",[string]$TaskSuffix='',[switch]$Purge)
$ErrorActionPreference='Stop'

# 计划任务可能由提权安装创建，普通权限删不掉；这里自请求提权再继续
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $isAdmin){
  Write-Host '需要管理员权限删除计划任务，正在请求提权（请在弹窗里点“是”）…'
  $argList=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-TargetDir',('"'+$TargetDir+'"'),'-TaskSuffix',('"'+$TaskSuffix+'"'))
  if($Purge){$argList+='-Purge'}
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  exit 0
}
$TargetDir=[IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
$marker=Join-Path $TargetDir 'install-state.json'
if(!(Test-Path $marker)){throw 'E_NOT_OURS: 未找到安装标记，拒绝清理'}
$state=Get-Content $marker -Raw|ConvertFrom-Json
if($state.target -ne $TargetDir -or $state.taskSuffix -ne $TaskSuffix){throw 'E_SCOPE: 安装目录或任务后缀不匹配'}
Write-Host '正在停止本安装的任务和进程……'
foreach($name in @("WeChatFishReader$TaskSuffix","WeChatFishBridge$TaskSuffix","WeChatFishApp$TaskSuffix","WeChatFishConsole$TaskSuffix","WeChatFishTray$TaskSuffix")){
 $t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
 if($t){if(!($t.Actions.Arguments -like "*$TargetDir*")){throw "E_TASK_SCOPE: 拒绝更改其他任务 $name"};Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;try{Unregister-ScheduledTask -TaskName $name -Confirm:$false}catch{schtasks.exe /delete /tn $name /f 2>&1|Out-Null;if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw "E_TASK_DELETE: 删不掉任务 $name"}}}
}
Get-CimInstance Win32_Process | Where-Object {($_.ExecutablePath -and $_.ExecutablePath.StartsWith($TargetDir+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like "*$TargetDir\start-*.vbs*")} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
$link=[Environment]::GetFolderPath('Desktop')+"\微信薄桥接$TaskSuffix.lnk";if(Test-Path $link){$sh=New-Object -ComObject WScript.Shell;if($sh.CreateShortcut($link).TargetPath -eq "$TargetDir\app\console\wechat-fish-console.exe"){Remove-Item -LiteralPath $link -Force}}
if(Test-Path "$TargetDir\client-acl.json"){$saved=Get-Content "$TargetDir\client-acl.json" -Raw|ConvertFrom-Json;$acl=Get-Acl "$TargetDir\client";$acl.SetSecurityDescriptorSddlForm($saved.sddl);Set-Acl "$TargetDir\client" $acl}
if($Purge){
 # Require marker, exact resolved path, no junctions, and a non-root directory.
 $resolved=(Resolve-Path -LiteralPath $TargetDir).Path
 if($resolved -ne $state.target -or $resolved.Length -lt 15 -or (Get-Item $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'E_PURGE_SCOPE: 目录安全检查失败'}
 if(@(Get-ChildItem $resolved -Recurse -Force -Attributes ReparsePoint).Count){throw 'E_PURGE_LINK: 目录内含链接，拒绝递归删除'}
 Write-Host "正在删除已确认的安装目录：$resolved"
 for($attempt=1;$attempt -le 5;$attempt++){
  # WMI command-line scope includes runtimes launched through a global executable.
  Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(pythonw?|node|wscript)\.exe$' -and $_.CommandLine -and $_.CommandLine.IndexOf($resolved+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  try {Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop;break} catch {if($attempt -eq 5){throw};Start-Sleep -Seconds 1}
 }
 if(Test-Path -LiteralPath $resolved){throw 'E_PURGE_INCOMPLETE'}
 Write-Host '卸载完成，目录已彻底删除。'
}else{Write-Host "卸载完成，保留数据：$TargetDir"}
